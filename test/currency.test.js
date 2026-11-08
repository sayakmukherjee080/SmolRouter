// Currency tagging, guarded currency changes, conversion, and per-currency analytics.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, adminLogin, waitFor } from './helpers/app.js';
import { startStubUpstream, jsonCompletion } from './helpers/upstream.js';

// Performs a JSON admin request with optional session credentials.
function request(baseUrl, path, { method = 'GET', body, cookie, csrf } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (csrf) headers['x-csrf-token'] = csrf;
  return fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// Starts a stub FX endpoint returning a fixed USD-to-INR rate.
async function startFxStub(rate = 83) {
  const stub = await startStubUpstream((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ rates: { INR: Number(req.url.includes('INR') ? rate : 0), USD: 1 } }));
  });
  return { ...stub, url: `${stub.baseUrl}/latest` };
}

// Seeds a model with downstream prices and an amount-rule token through the admin API.
async function seedMonetary(app, session) {
  const model = await request(app.baseUrl, '/models', {
    method: 'POST', cookie: session.cookie, csrf: session.csrf,
    body: { name: 'priced', downstreamInputCostPerM: 2, downstreamOutputCostPerM: 4 },
  });
  assert.equal(model.status, 201);
  const token = await request(app.baseUrl, '/tokens', {
    method: 'POST', cookie: session.cookie, csrf: session.csrf,
    body: { label: 'spend', budgetRules: [{ metric: 'amount', period: 'day', limit_value: 1 }] },
  });
  assert.equal(token.status, 201);
  return { modelId: (await model.json()).data.id, tokenId: (await token.json()).data.id };
}

test('currency changes with monetary data require conversion and convert atomically', async (t) => {
  const fxStub = await startFxStub(83);
  const app = await createTestApp({ env: { FX_API_URL: fxStub.url } });
  const session = await adminLogin(app.baseUrl);
  const { modelId, tokenId } = await seedMonetary(app, session);
  await t.after(async () => {
    await app.close();
    await fxStub.close();
  });

  const window = Math.floor(Date.now() / 86400000) * 86400000;
  app.db.prepare(`INSERT INTO token_usage_events
    (ts, token_id, requests, tokens_in, tokens_out, downstream_cost, currency, fx_rate, is_cache)
    VALUES (?, ?, 1, 10, 5, 1, 'USD', 1, 0)`).run(Date.now(), tokenId);
  app.db.prepare(`INSERT INTO usage
    (entity, entity_id, window_start, currency, requests, tokens_in, tokens_out, cost, downstream_cost, fx_rate)
    VALUES ('token', ?, ?, 'USD', 1, 10, 5, 0.1, 1, 1)`).run(tokenId, window);

  const blocked = await request(app.baseUrl, '/settings', {
    method: 'PUT', cookie: session.cookie, csrf: session.csrf,
    body: { billing_currency: 'INR' },
  });
  assert.equal(blocked.status, 422);
  assert.match((await blocked.json()).error, /convertCurrency/);

  const settings = await request(app.baseUrl, '/settings', { cookie: session.cookie });
  assert.equal((await settings.json()).data.settings.billing_currency, 'USD', 'blocked change persisted nothing');

  const converted = await request(app.baseUrl, '/settings', {
    method: 'PUT', cookie: session.cookie, csrf: session.csrf,
    body: { billing_currency: 'INR', convertCurrency: true },
  });
  assert.equal(converted.status, 200);
  assert.equal((await converted.json()).data.settings.billing_currency, 'INR');

  const models = await request(app.baseUrl, '/models', { cookie: session.cookie });
  const model = (await models.json()).data.models.find((item) => item.id === modelId);
  assert.equal(model.downstreamCurrency, 'INR');
  assert.equal(model.downstreamInputCostPerM, 166);
  assert.equal(model.downstreamOutputCostPerM, 332);

  const token = await request(app.baseUrl, `/tokens/${tokenId}`, { cookie: session.cookie });
  const rule = (await token.json()).data.token.budgetRules[0];
  assert.equal(rule.currency, 'INR');
  assert.equal(rule.limit, 83);
  assert.equal(fxStub.state.requests.length, 1, 'one FX fetch for the new currency');

  const event = app.db.prepare('SELECT downstream_cost, currency FROM token_usage_events WHERE token_id = ?').get(tokenId);
  assert.equal(event.currency, 'INR');
  assert.equal(event.downstream_cost, 83, 'current billing events are converted');
  const historical = app.db.prepare("SELECT currency, downstream_cost FROM usage WHERE entity = 'token' AND entity_id = ?").get(tokenId);
  assert.equal(historical.currency, 'USD', 'historical usage rows keep their currency');
  assert.equal(historical.downstream_cost, 1, 'historical usage rows are not rewritten');
});

test('unavailable FX rejects conversion without partial writes', async (t) => {
  const app = await createTestApp({ env: { FX_API_URL: 'http://127.0.0.1:1/latest' } });
  const session = await adminLogin(app.baseUrl);
  const { modelId } = await seedMonetary(app, session);
  await t.after(() => app.close());

  const converted = await request(app.baseUrl, '/settings', {
    method: 'PUT', cookie: session.cookie, csrf: session.csrf,
    body: { billing_currency: 'INR', convertCurrency: true },
  });
  assert.equal(converted.status, 422);
  assert.match((await converted.json()).error, /conversion unavailable/);

  const settings = await request(app.baseUrl, '/settings', { cookie: session.cookie });
  assert.equal((await settings.json()).data.settings.billing_currency, 'USD');
  const models = await request(app.baseUrl, '/models', { cookie: session.cookie });
  const model = (await models.json()).data.models.find((item) => item.id === modelId);
  assert.equal(model.downstreamCurrency, 'USD');
  assert.equal(model.downstreamInputCostPerM, 2);
});

test('currency changes without monetary data apply directly', async (t) => {
  const app = await createTestApp();
  const session = await adminLogin(app.baseUrl);
  await t.after(() => app.close());

  const changed = await request(app.baseUrl, '/settings', {
    method: 'PUT', cookie: session.cookie, csrf: session.csrf,
    body: { billing_currency: 'EUR' },
  });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).data.settings.billing_currency, 'EUR');
});

test('usage analytics keep currencies in separate margin groups', async (t) => {
  const app = await createTestApp();
  const session = await adminLogin(app.baseUrl);
  await t.after(() => app.close());

  const window = Math.floor(Date.now() / 86400000) * 86400000;
  const insert = app.db.prepare(`INSERT INTO usage
    (entity, entity_id, window_start, currency, requests, tokens_in, tokens_out, cost, upstream_cost, downstream_cost, fx_rate)
    VALUES ('model', 1, ?, ?, 1, 100, 50, 0.001, 0.0005, ?, ?)`);
  insert.run(window, 'USD', 0.002, 1);
  insert.run(window, 'INR', 0.1, 83);

  const payload = await (await request(app.baseUrl, '/usage', { cookie: session.cookie })).json();
  const groups = payload.data.currencySummary;
  assert.equal(groups.length, 2);
  const usd = groups.find((row) => row.currency === 'USD');
  const inr = groups.find((row) => row.currency === 'INR');
  assert.ok(Math.abs(usd.margin - 0.0015) < 1e-12);
  assert.ok(Math.abs(inr.margin - (0.1 - 0.0005 * 83)) < 1e-12);
  assert.equal(payload.data.usage.filter((row) => row.entity === 'model').length, 2, 'usage rows remain separate');
});

test('route quota counters sum usage across currencies after a reload', async (t) => {
  const app = await createTestApp();
  const provider = app.addProvider('route-counter', 'http://127.0.0.1:1/v1');
  const model = app.app.registry.createModel({ name: 'route-counter' });
  const route = app.app.registry.createRoute({ modelId: model.id, providerId: provider.id, upstreamModel: 'u', dailyQuota: 10 });
  await t.after(() => app.close());

  const window = Math.floor(Date.now() / 86400000) * 86400000;
  const insert = app.db.prepare(`INSERT INTO usage
    (entity, entity_id, window_start, currency, requests) VALUES ('route', ?, ?, ?, ?)`);
  insert.run(route.id, window, 'USD', 2);
  insert.run(route.id, window, 'INR', 3);
  app.app.registry.load();
  assert.equal(app.app.registry.routeCount(route.id), 5, 'route quota counts every currency bucket');
});

test('usage margin is unavailable when a legacy non-USD rate is missing', async (t) => {
  const app = await createTestApp();
  const session = await adminLogin(app.baseUrl);
  await t.after(() => app.close());

  const window = Math.floor(Date.now() / 86400000) * 86400000;
  app.db.prepare(`INSERT INTO usage
    (entity, entity_id, window_start, currency, requests, cost, upstream_cost, downstream_cost, fx_rate)
    VALUES ('model', 1, ?, 'INR', 1, 0.001, 0.0005, 0.1, NULL)`).run(window);
  app.db.prepare(`INSERT INTO usage
    (entity, entity_id, window_start, currency, requests, cost, upstream_cost, downstream_cost, fx_rate)
    VALUES ('model', 2, ?, 'USD', 1, 0.001, 0.0005, 0.002, 1)`).run(window);

  const payload = await (await request(app.baseUrl, '/usage', { cookie: session.cookie })).json();
  const inr = payload.data.currencySummary.find((row) => row.currency === 'INR');
  const usd = payload.data.currencySummary.find((row) => row.currency === 'USD');
  assert.equal(inr.margin, null, 'missing historical FX is not treated as 1:1');
  assert.ok(Math.abs(usd.margin - 0.0015) < 1e-12);
});

test('settings flag legacy USD amounts when the billing currency is not USD', async (t) => {
  const app = await createTestApp({ env: { BILLING_CURRENCY: 'INR' } });
  const session = await adminLogin(app.baseUrl);
  const { token } = app.app.registry.createToken({
    label: 'legacy-review',
    budgetRules: [{ metric: 'amount', period: 'day', limit_value: 10 }],
  });
  app.db.prepare(`INSERT INTO token_usage_events
    (ts, token_id, requests, tokens_in, tokens_out, downstream_cost, currency, fx_rate, is_cache)
    VALUES (?, ?, 1, 1, 1, 1, NULL, NULL, 0)`).run(Date.now(), token.id);
  await t.after(() => app.close());

  const payload = await (await request(app.baseUrl, '/settings', { cookie: session.cookie })).json();
  const review = payload.data.settings.legacy_amount_review;
  assert.equal(review.currency, 'INR');
  assert.equal(review.review, true);
  assert.equal(review.amountRules, 1);
  assert.equal(review.legacyEvents, 1);
});


test('currency changes drain in-flight requests and convert their billing events', async (t) => {
  const fxStub = await startFxStub(83);
  let releaseUpstream;
  const gate = new Promise((resolve) => { releaseUpstream = resolve; });
  const upstream = await startStubUpstream(async (req, res) => {
    await gate;
    jsonCompletion(res, { usage: { prompt_tokens: 10, completion_tokens: 5 } });
  });
  const app = await createTestApp({
    env: { FX_API_URL: fxStub.url, CURRENCY_CHANGE_DRAIN_MS: '1000' },
  });
  const session = await adminLogin(app.baseUrl);
  const provider = app.addProvider('drain', upstream.baseUrl);
  const model = app.app.registry.createModel({
    name: 'drain',
    downstreamInputCostPerM: 1,
    downstreamOutputCostPerM: 1,
  });
  app.app.registry.createRoute({ modelId: model.id, providerId: provider.id, upstreamModel: 'u' });
  const { token, raw } = app.app.registry.createToken({
    label: 'drain',
    budgetRules: [{ metric: 'amount', period: 'day', limit_value: 100 }],
  });
  app.app.registry.setTokenModels(token.id, [model.id]);
  await t.after(async () => {
    await app.close();
    await fxStub.close();
    await upstream.close();
  });

  const chat = fetch(`${app.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${raw}` },
    body: JSON.stringify({ model: 'drain', messages: [{ role: 'user', content: 'hi' }] }),
  });
  await waitFor(() => upstream.state.requests.length > 0);

  const blocked = await request(app.baseUrl, '/settings', {
    method: 'PUT', cookie: session.cookie, csrf: session.csrf,
    body: { billing_currency: 'INR', convertCurrency: true },
  });
  assert.equal(blocked.status, 422);
  assert.match((await blocked.json()).error, /in-flight gateway requests/);
  assert.equal(app.app.registry.currencyChange, false, 'failed drain unlocks admissions');
  const unchanged = await (await request(app.baseUrl, '/settings', { cookie: session.cookie })).json();
  assert.equal(unchanged.data.settings.billing_currency, 'USD', 'failed drain persists nothing');

  app.app.registry.beginCurrencyChange();
  const locked = await fetch(`${app.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${raw}` },
    body: JSON.stringify({ model: 'drain', messages: [{ role: 'user', content: 'locked' }] }),
  });
  assert.equal(locked.status, 503);
  assert.equal((await locked.json()).error.code, 'currency_change_in_progress');
  app.app.registry.endCurrencyChange();

  releaseUpstream();
  const completed = await chat;
  assert.equal(completed.status, 200);
  await completed.text();
  await waitFor(() => app.app.registry.activeRequests === 0);

  const converted = await request(app.baseUrl, '/settings', {
    method: 'PUT', cookie: session.cookie, csrf: session.csrf,
    body: { billing_currency: 'INR', convertCurrency: true },
  });
  assert.equal(converted.status, 200);
  const event = app.db.prepare('SELECT downstream_cost, currency FROM token_usage_events WHERE token_id = ? ORDER BY id DESC LIMIT 1').get(token.id);
  assert.equal(event.currency, 'INR', 'in-flight billing event was flushed before conversion');
  assert.ok(Math.abs(event.downstream_cost - 0.000015 * 83) < 1e-12, 'in-flight charge was converted');
});

