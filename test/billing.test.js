// Downstream pricing, unified budget rules, LiteLLM surfaces, and cost capture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, adminLogin } from './helpers/app.js';
import { startStubUpstream, jsonCompletion } from './helpers/upstream.js';

// Seeds a provider, model, route, and token.
function seed(app, upstreamBase, {
  modelName = 'metered', providerName = `provider-${modelName}`,
  downstreamInput = null, downstreamOutput = null,
  inputCostPerM = 1, outputCostPerM = 2, budgetRules = null,
} = {}) {
  const provider = app.addProvider(providerName, upstreamBase);
  const model = app.app.registry.createModel({
    name: modelName,
    downstreamInputCostPerM: downstreamInput,
    downstreamOutputCostPerM: downstreamOutput,
  });
  app.app.registry.createRoute({ modelId: model.id, providerId: provider.id, upstreamModel: 'u', inputCostPerM, outputCostPerM });
  const { token, raw } = app.app.registry.createToken({ label: 'client', budgetRules });
  app.app.registry.setTokenModels(token.id, [model.id]);
  return { provider, model, token, raw };
}

// Sends one chat completion.
async function chat(baseUrl, raw, body = {}) {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${raw}` },
    body: JSON.stringify({ model: 'metered', messages: [{ role: 'user', content: 'hi' }], ...body }),
  });
  await response.text();
  return response;
}

test('downstream prices drive headers, /model/info, and /key/info', async (t) => {
  const upstream = await startStubUpstream((req, res) =>
    jsonCompletion(res, { usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  const app = await createTestApp();
  const { raw } = seed(app, upstream.baseUrl, {
    downstreamInput: 3, downstreamOutput: 4,
    budgetRules: [{ metric: 'amount', period: 'day', limit_value: 1 }],
  });
  await t.after(async () => {
    await app.close();
    await upstream.close();
  });

  const response = await chat(app.baseUrl, raw);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-litellm-model-id'), 'metered');
  assert.equal(response.headers.get('x-litellm-response-cost'), '0.000050');
  assert.equal(response.headers.get('x-request-cost'), '0.000050');
  assert.equal(response.headers.get('x-litellm-key-max-budget'), '1');

  const modelInfo = await (await fetch(`${app.baseUrl}/model/info`, {
    headers: { authorization: `Bearer ${raw}` },
  })).json();
  assert.equal(modelInfo.data[0].model_info.input_cost_per_million, 3);
  assert.equal(modelInfo.data[0].model_info.output_cost_per_million, 4);
  assert.equal(modelInfo.data[0].model_info.currency, 'USD');
  assert.equal(modelInfo.data[0].model_info.upstream_input_cost_per_million, undefined);

  const keyInfo = await (await fetch(`${app.baseUrl}/key/info`, {
    headers: { authorization: `Bearer ${raw}` },
  })).json();
  assert.equal(keyInfo.info.currency, 'USD');
  assert.equal(keyInfo.info.budget_rules[0].metric, 'amount');
  assert.ok(Number(keyInfo.info.spend) > 0);

  await app.flush();
  const usage = app.db.prepare("SELECT * FROM usage WHERE entity = 'model'").get();
  assert.ok(Math.abs(usage.downstream_cost - 0.00005) < 1e-12);
  assert.ok(Math.abs(usage.cost - 0.00002) < 1e-12);
});

test('request, token, and amount rules block at their limits', async (t) => {
  const upstream = await startStubUpstream((req, res) =>
    jsonCompletion(res, { usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  const app = await createTestApp();
  const requests = seed(app, upstream.baseUrl, {
    modelName: 'requests-rule', providerName: 'provider-requests',
    budgetRules: [{ metric: 'requests', period: 'day', limit_value: 1 }],
  });
  const tokens = seed(app, upstream.baseUrl, {
    modelName: 'tokens-rule', providerName: 'provider-tokens',
    budgetRules: [{ metric: 'tokens_total', period: 'hour', limit_value: 25 }],
  });
  const amount = seed(app, upstream.baseUrl, {
    modelName: 'amount-rule', providerName: 'provider-amount',
    downstreamInput: 1, downstreamOutput: 1,
    budgetRules: [{ metric: 'amount', period: 'day', limit_value: 0.00003 }],
  });
  await t.after(async () => {
    await app.close();
    await upstream.close();
  });

  assert.equal((await chat(app.baseUrl, requests.raw, { model: 'requests-rule' })).status, 200);
  assert.equal((await chat(app.baseUrl, requests.raw, { model: 'requests-rule' })).status, 429);

  assert.equal((await chat(app.baseUrl, tokens.raw, { model: 'tokens-rule', max_tokens: 1 })).status, 200);
  assert.equal((await chat(app.baseUrl, tokens.raw, { model: 'tokens-rule', max_tokens: 1 })).status, 429);

  assert.equal((await chat(app.baseUrl, amount.raw, { model: 'amount-rule' })).status, 200);
  assert.equal((await chat(app.baseUrl, amount.raw, { model: 'amount-rule' })).status, 429);
});

test('concurrent admission is exact for request, token, amount, and route quota limits', async (t) => {
  const upstream = await startStubUpstream(async (req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    jsonCompletion(res, { usage: { prompt_tokens: 10, completion_tokens: 5 } });
  });
  const app = await createTestApp();
  const requestUser = seed(app, upstream.baseUrl, {
    modelName: 'concurrent-requests', providerName: 'provider-concurrent-requests',
    budgetRules: [{ metric: 'requests', period: 'day', limit_value: 1 }],
  });
  const tokenUser = seed(app, upstream.baseUrl, {
    modelName: 'concurrent-tokens', providerName: 'provider-concurrent-tokens',
    budgetRules: [{ metric: 'tokens_total', period: 'hour', limit_value: 25 }],
  });
  const amountUser = seed(app, upstream.baseUrl, {
    modelName: 'concurrent-amount', providerName: 'provider-concurrent-amount',
    downstreamInput: 1, downstreamOutput: 1,
    budgetRules: [{ metric: 'amount', period: 'day', limit_value: 0.00003 }],
  });
  const quotaProvider = app.addProvider('provider-concurrent-quota', upstream.baseUrl);
  const quotaModel = app.app.registry.createModel({ name: 'concurrent-quota' });
  app.app.registry.createRoute({ modelId: quotaModel.id, providerId: quotaProvider.id, upstreamModel: 'u', dailyQuota: 1 });
  const quotaToken = app.addToken('quota-client', [quotaModel.id]);
  await t.after(async () => {
    await app.close();
    await upstream.close();
  });

  const burst = (raw, model) => Promise.all(Array.from({ length: 20 }, () =>
    chat(app.baseUrl, raw, { model, max_tokens: 1 })));
  const statuses = async (raw, model) => {
    const responses = await burst(raw, model);
    return {
      ok: responses.filter((response) => response.status === 200).length,
      blocked: responses.filter((response) => response.status === 429).length,
    };
  };

  assert.deepEqual(await statuses(requestUser.raw, 'concurrent-requests'), { ok: 1, blocked: 19 });
  assert.deepEqual(await statuses(tokenUser.raw, 'concurrent-tokens'), { ok: 1, blocked: 19 });
  assert.deepEqual(await statuses(amountUser.raw, 'concurrent-amount'), { ok: 1, blocked: 19 });
  assert.deepEqual(await statuses(quotaToken.raw, 'concurrent-quota'), { ok: 1, blocked: 19 });
});

test('cache hits persist rule consumption across a counter rebuild', async (t) => {
  const upstream = await startStubUpstream((req, res) => jsonCompletion(res, { usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  const app = await createTestApp();
  const { raw } = seed(app, upstream.baseUrl, {
    modelName: 'durable-cache',
    budgetRules: [{ metric: 'requests', period: 'day', limit_value: 2 }],
  });
  await t.after(async () => {
    await app.close();
    await upstream.close();
  });

  const first = await chat(app.baseUrl, raw, { model: 'durable-cache', temperature: 0 });
  assert.equal(first.status, 200);
  const second = await chat(app.baseUrl, raw, { model: 'durable-cache', temperature: 0 });
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('x-cache'), 'hit');
  await app.flush();
  app.app.registry.budgets.load();
  assert.equal((await chat(app.baseUrl, raw, { model: 'durable-cache', temperature: 0 })).status, 429);
});

test('cache hits persist downstream amount consumption', async (t) => {
  const upstream = await startStubUpstream((req, res) =>
    jsonCompletion(res, { usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  const app = await createTestApp();
  const { raw } = seed(app, upstream.baseUrl, {
    modelName: 'durable-amount', downstreamInput: 1, downstreamOutput: 1,
    budgetRules: [{ metric: 'amount', period: 'day', limit_value: 0.00005 }],
  });
  await t.after(async () => {
    await app.close();
    await upstream.close();
  });

  assert.equal((await chat(app.baseUrl, raw, { model: 'durable-amount', temperature: 0 })).status, 200);
  assert.equal((await chat(app.baseUrl, raw, { model: 'durable-amount', temperature: 0 })).headers.get('x-cache'), 'hit');
  await app.flush();
  app.app.registry.budgets.load();
  assert.equal((await chat(app.baseUrl, raw, { model: 'durable-amount', temperature: 0 })).status, 429);
});

test('provider-reported cost is stored', async (t) => {
  const upstream = await startStubUpstream((req, res) =>
    jsonCompletion(res, { usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.000123 } }));
  const app = await createTestApp();
  const { raw } = seed(app, upstream.baseUrl, { modelName: 'reported-cost' });
  await t.after(async () => {
    await app.close();
    await upstream.close();
  });

  assert.equal((await chat(app.baseUrl, raw, { model: 'reported-cost' })).status, 200);
  await app.flush();
  const row = app.db.prepare('SELECT upstream_cost FROM telemetry ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.upstream_cost, 0.000123);
});

test('client aborts leave a 499 telemetry row', async (t) => {
  const upstream = await startStubUpstream(async (req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    jsonCompletion(res);
  });
  const app = await createTestApp();
  const { raw } = seed(app, upstream.baseUrl, { modelName: 'abort' });
  await t.after(async () => {
    await app.close();
    await upstream.close();
  });

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(fetch(`${app.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${raw}` },
    body: JSON.stringify({ model: 'abort', messages: [] }),
    signal: controller.signal,
  }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  await app.flush();
  const row = app.db.prepare('SELECT status, error FROM telemetry ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.status, 499);
  assert.equal(row.error, 'client_closed');
  assert.equal(app.app.registry.activeRequests, 0, 'aborted request released its active slot');
});

test('admin can set downstream pricing and rule rows', async (t) => {
  const app = await createTestApp();
  const session = await adminLogin(app.baseUrl);
  await t.after(() => app.close());

  const model = await fetch(`${app.baseUrl}/api/v1/models`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: session.cookie, 'x-csrf-token': session.csrf },
    body: JSON.stringify({ name: 'admin-priced', downstreamInputCostPerM: 2, downstreamOutputCostPerM: 5 }),
  });
  assert.equal(model.status, 201);
  const modelId = (await model.json()).data.id;

  const token = await fetch(`${app.baseUrl}/api/v1/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: session.cookie, 'x-csrf-token': session.csrf },
    body: JSON.stringify({
      label: 'rules', timezone: 'Asia/Kolkata',
      budgetRules: [{ metric: 'tokens_total', period: 'n_days', period_count: 7, limit_value: 1000, reset_time: 1410, anchor: '2026-01-01' }],
    }),
  });
  assert.equal(token.status, 201);
  const tokenId = (await token.json()).data.id;

  const info = await fetch(`${app.baseUrl}/api/v1/tokens/${tokenId}`, {
    headers: { cookie: session.cookie },
  });
  const payload = await info.json();
  assert.equal(payload.data.token.timezone, 'Asia/Kolkata');
  assert.equal(payload.data.token.budgetRules[0].metric, 'tokens_total');
  assert.equal(payload.data.token.budgetRules[0].periodCount, 7);
  assert.ok(modelId > 0);
});

test('no prompt or completion content columns exist', async (t) => {
  const app = await createTestApp();
  await t.after(() => app.close());
  const tables = ['telemetry', 'usage', 'token_usage_events'];
  for (const table of tables) {
    const columns = app.db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    for (const column of columns) {
      assert.doesNotMatch(column, /prompt|completion|content|message|body/i, `${table}.${column} must not store content`);
    }
  }
});

test('token create, update, and import are atomic when budget rules are invalid', async (t) => {
  const app = await createTestApp();
  await t.after(() => app.close());
  const registry = app.app.registry;
  const before = registry.listTokens().length;
  assert.throws(
    () => registry.createToken({ label: 'bad-create', budgetRules: [{ metric: 'nope', period: 'day', limit_value: 1 }] }),
    /unknown budget metric/,
  );
  assert.throws(
    () => registry.createToken({ label: 'bad-shape', budgetRules: { metric: 'requests' } }),
    /budgetRules must be an array/,
  );
  assert.equal(registry.listTokens().length, before, 'failed create leaves no token row');

  const { token } = registry.createToken({
    label: 'atomic',
    budgetRules: [{ metric: 'tokens_total', period: 'day', limit_value: 100 }],
  });
  assert.throws(
    () => registry.updateToken(token.id, { label: 'should-not-stick', budgetRules: [{ metric: 'nope' }] }),
    /unknown budget metric/,
  );
  assert.throws(
    () => registry.updateToken(token.id, { budgetRules: { metric: 'requests' } }),
    /budgetRules must be an array/,
  );
  assert.equal(registry.findTokenById(token.id).label, 'atomic', 'failed update leaves columns unchanged');
  assert.equal(registry.budgetRulesForToken(token.id)[0].limit_value, 100, 'failed update leaves rules unchanged');

  const hash = 'b'.repeat(64);
  assert.throws(
    () => registry.importToken({ keyHash: hash, label: 'bad-import', budgetRules: [{ metric: 'nope' }] }),
    /unknown budget metric/,
  );
  assert.equal(registry.listTokens().some((item) => item.keyHash === hash), false, 'failed import leaves no token row');

  const imported = registry.importToken({
    keyHash: hash,
    label: 'imported',
    budgetRules: [{ metric: 'requests', period: 'day', limit_value: 2 }],
  });
  assert.equal(registry.budgetRulesForToken(imported.id)[0].limit_value, 2, 'valid import persists rules');
});

test('budget windows longer than token usage retention are rejected', async (t) => {
  const app = await createTestApp();
  await t.after(() => app.close());
  assert.throws(
    () => app.app.registry.createToken({
      label: 'too-long',
      budgetRules: [{ metric: 'requests', period: 'n_days', period_count: 500, limit_value: 1, anchor: '2026-01-01' }],
    }),
    /exceeds token_usage_retention_days/,
  );
  assert.equal(app.app.registry.listTokens().length, 0, 'rejected rule leaves no token');
});

test('rule anchors are validated before any write', async (t) => {
  const app = await createTestApp();
  await t.after(() => app.close());
  const registry = app.app.registry;
  assert.throws(
    () => registry.createToken({
      label: 'bad-anchor-hour',
      budgetRules: [{ metric: 'requests', period: 'n_hours', period_count: 5, limit_value: 1, anchor: 99 }],
    }),
    /n_hours anchor must be 0-23/,
  );
  assert.throws(
    () => registry.createToken({
      label: 'bad-anchor-date',
      budgetRules: [{ metric: 'requests', period: 'n_days', period_count: 7, limit_value: 1, anchor: '2026-02-31' }],
    }),
    /real calendar date/,
  );
  assert.equal(registry.listTokens().length, 0, 'invalid anchors leave no token');
});

test('in-flight reservations follow replaced budget rules by shape', async (t) => {
  const app = await createTestApp();
  await t.after(() => app.close());
  const registry = app.app.registry;
  const { token } = registry.createToken({
    label: 'replacement',
    budgetRules: [{ metric: 'tokens_total', period: 'day', limit_value: 100 }],
  });

  const reservation = registry.reserveTokenRules(token, { tokensIn: 10, tokensOut: 5, amount: 0 });
  assert.equal(reservation.ok, true);
  assert.equal(registry.tokenBudgetReport(token, 0.8).rules[0].used, 15, 'estimate reserved');

  registry.replaceTokenBudgetRules(token.id, [{ metric: 'tokens_total', period: 'day', limit_value: 100 }]);
  const replaced = registry.budgetRulesForToken(token.id)[0];
  assert.notEqual(replaced.id, reservation.handles[0].ruleId, 'replacement created a new rule id');

  registry.reconcileTokenRules(reservation.handles, { requests: 1, tokensIn: 20, tokensOut: 10, amount: 0 });
  assert.equal(registry.tokenBudgetReport(token, 0.8).rules[0].used, 30, 'actual usage lands on the replacement rule');

  const second = registry.reserveTokenRules(token, { tokensIn: 5, tokensOut: 0, amount: 0 });
  registry.releaseTokenRules(second.handles);
  registry.releaseTokenRules(second.handles);
  assert.equal(registry.tokenBudgetReport(token, 0.8).rules[0].used, 30, 'repeated release never subtracts twice');
});

test('abandoning a reservation after a rule replacement keeps persisted usage intact', async (t) => {
  const app = await createTestApp();
  await t.after(() => app.close());
  const registry = app.app.registry;
  const { token } = registry.createToken({
    label: 'release-replacement',
    budgetRules: [{ metric: 'tokens_total', period: 'day', limit_value: 100 }],
  });
  app.db.prepare(`INSERT INTO token_usage_events
    (ts, token_id, requests, tokens_in, tokens_out, downstream_cost, currency, fx_rate, is_cache)
    VALUES (?, ?, 1, 30, 10, 0, 'USD', 1, 0)`).run(Date.now(), token.id);
  registry.loadTokenCounters();
  registry.replaceTokenBudgetRules(token.id, [{ metric: 'tokens_total', period: 'day', limit_value: 100 }]);
  assert.equal(registry.tokenBudgetReport(token, 0.8).rules[0].used, 40, 'persisted usage loaded');

  const reservation = registry.reserveTokenRules(token, { tokensIn: 10, tokensOut: 5, amount: 0 });
  assert.equal(registry.tokenBudgetReport(token, 0.8).rules[0].used, 55, 'estimate reserved');
  registry.replaceTokenBudgetRules(token.id, [{ metric: 'tokens_total', period: 'day', limit_value: 100 }]);
  registry.releaseTokenRules(reservation.handles);
  assert.equal(
    registry.tokenBudgetReport(token, 0.8).rules[0].used,
    40,
    'abandonment never subtracts from a replacement counter it was not reserved in',
  );
});

test('settled usage survives a same-shape rule edit before telemetry flush', async (t) => {
  const app = await createTestApp();
  await t.after(() => app.close());
  const registry = app.app.registry;
  const { token } = registry.createToken({
    label: 'unflushed',
    budgetRules: [{ metric: 'tokens_total', period: 'day', limit_value: 1000 }],
  });

  const reservation = registry.reserveTokenRules(token, { tokensIn: 10, tokensOut: 5, amount: 0 });
  registry.reconcileTokenRules(reservation.handles, { requests: 1, tokensIn: 20, tokensOut: 10, amount: 0 });
  assert.equal(registry.tokenBudgetReport(token, 0.8).rules[0].used, 30, 'actual usage settled');

  registry.replaceTokenBudgetRules(token.id, [{ metric: 'tokens_total', period: 'day', limit_value: 2000 }]);
  assert.equal(registry.tokenBudgetReport(token, 0.8).rules[0].used, 30, 'same-shape edit keeps settled usage');
});

test('unified rules appear in headers and /key/info spend totals every amount rule', async (t) => {
  const upstream = await startStubUpstream((req, res) =>
    jsonCompletion(res, { usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  const app = await createTestApp();
  const { raw } = seed(app, upstream.baseUrl, {
    modelName: 'visible-rules', providerName: 'provider-visible-rules',
    downstreamInput: 1, downstreamOutput: 1,
    budgetRules: [
      { metric: 'amount', period: 'day', limit_value: 1 },
      { metric: 'amount', period: 'month', limit_value: 10 },
      { metric: 'tokens_total', period: 'hour', limit_value: 1000 },
    ],
  });
  await t.after(async () => {
    await app.close();
    await upstream.close();
  });

  const response = await chat(app.baseUrl, raw, { model: 'visible-rules' });
  assert.equal(response.status, 200);
  const ruleHeader = response.headers.get('x-budget-rules');
  assert.match(ruleHeader, /amount_day=/);
  assert.match(ruleHeader, /amount_month=/);
  assert.match(ruleHeader, /tokens_total_hourly=/);
  assert.match(response.headers.get('x-budget-remaining'), /tokens_total_hourly=/);

  const keyInfo = await (await fetch(`${app.baseUrl}/key/info`, {
    headers: { authorization: `Bearer ${raw}` },
  })).json();
  const amountRules = keyInfo.info.budget_rules.filter((rule) => rule.metric === 'amount');
  assert.equal(amountRules.length, 2);
  const expected = amountRules.reduce((sum, rule) => sum + rule.used, 0);
  assert.ok(expected > 0);
  assert.ok(Math.abs(keyInfo.info.spend - expected) < 1e-12, 'spend sums every amount rule');
});

test('model info reports route-dependent pass-through pricing', async (t) => {
  const app = await createTestApp();
  const first = app.addProvider('pricing-a', 'http://127.0.0.1:1/v1');
  const second = app.addProvider('pricing-b', 'http://127.0.0.1:1/v1');
  const model = app.app.registry.createModel({ name: 'multi-route-pricing' });
  app.app.registry.createRoute({ modelId: model.id, providerId: first.id, upstreamModel: 'cheap', inputCostPerM: 1, outputCostPerM: 2 });
  app.app.registry.createRoute({ modelId: model.id, providerId: second.id, upstreamModel: 'dear', inputCostPerM: 3, outputCostPerM: 6 });
  const { raw } = app.addToken('route-dependent', [model.id]);
  await t.after(() => app.close());

  const payload = await (await fetch(`${app.baseUrl}/model/info`, {
    headers: { authorization: `Bearer ${raw}` },
  })).json();
  const info = payload.data[0].model_info;
  assert.equal(info.pricing_source, 'route_dependent');
  assert.equal(info.input_cost_per_million, null);
  assert.equal(info.input_cost_per_million_min, 1);
  assert.equal(info.input_cost_per_million_max, 3);
  assert.equal(info.output_cost_per_million_min, 2);
  assert.equal(info.output_cost_per_million_max, 6);
  assert.equal(info.cached_input_cost_per_million, null);
  assert.equal(info.cached_input_cost_per_million_min, 1);
  assert.equal(info.cached_input_cost_per_million_max, 3);
  assert.equal(info.currency, 'USD');
});
