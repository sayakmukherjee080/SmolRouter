// TPS recovery probe behavior: fallbacks, adaptive budgets, failures, and abort handling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startStubUpstream, jsonCompletion } from './helpers/upstream.js';
import { createTpsProbe } from '../src/gateway/tps_probe.js';
import { chat, sample, sseUsage, seedRoutes, sleep } from './helpers/tps.js';

test('probe timeout aborts the upstream request', async () => {
  const provider = { id: 1, name: 'p', baseUrl: 'http://127.0.0.1:1/v1' };
  const key = { id: 1, providerId: 1, key: 'k', enabled: true, disabledUntil: 0 };
  const registry = {
    providerById: () => provider,
    nextProviderKey: () => key,
    setting: (name, fallback) => fallback,
  };
  const probe = createTpsProbe({
    registry,
    config: {
      tpsProbeTimeoutMs: 20,
      tpsProbeMaxTokens: 100,
      tpsProbePrompt: 'code',
      usageParseMaxBytes: 1024,
      keyDisableMs: 1000,
    },
    telemetry: { queue: () => {} },
    logger: { warn: () => {} },
    metrics: { recordProbe: () => {} },
    fetchImpl: (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
  const route = { id: 1, modelId: 1, providerId: 1, upstreamModel: 'm' };
  const model = { id: 1, name: 'm', tpsMaxTtftMs: null };
  const result = await probe.run(route, model);
  assert.equal(result.valid, false);
  assert.equal(result.measured, false);
});

test('probe infrastructure failures do not reset a restore streak', async (t) => {
  let calls = 0;
  const upstreamA = await startStubUpstream((req, res) => {
    calls += 1;
    if (calls === 2) {
      jsonCompletion(res, { status: 429 });
      return;
    }
    sseUsage(res, { contentTokens: 200 });
  });
  const upstreamB = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'B' }));
  const { app, model, routeA } = await seedRoutes(upstreamA, upstreamB);
  await t.after(async () => {
    await app.close();
    await upstreamA.close();
    await upstreamB.close();
  });
  app.app.registry.updateModel(model.id, { tpsFloor: 100, preferredRouteId: routeA.id });
  for (let i = 0; i < 12; i += 1) app.app.tps.recordSample(routeA, sample({ effectiveTps: 50 }));

  assert.equal(await app.app.tps.probeNow(routeA.id), true);
  assert.equal(await app.app.tps.probeNow(routeA.id), false, '429 is a failed probe');
  assert.equal(app.app.tps.status(model).restore_streak, 1, 'the 429 did not reset the streak');
  assert.equal(await app.app.tps.probeNow(routeA.id), true);
  assert.equal(await app.app.tps.probeNow(routeA.id), true);
  assert.equal(app.app.tps.isDegraded(routeA.id), false);
  assert.equal(calls, 4);
});

test('short probe samples keep the restore streak instead of resetting it', async (t) => {
  let calls = 0;
  const upstreamA = await startStubUpstream((req, res) => {
    calls += 1;
    sseUsage(res, { contentTokens: calls === 2 || calls === 3 ? 50 : 200 });
  });
  const upstreamB = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'B' }));
  const { app, model, routeA } = await seedRoutes(upstreamA, upstreamB);
  await t.after(async () => {
    await app.close();
    await upstreamA.close();
    await upstreamB.close();
  });
  app.app.registry.updateModel(model.id, { tpsFloor: 100, preferredRouteId: routeA.id });
  for (let i = 0; i < 12; i += 1) app.app.tps.recordSample(routeA, sample({ effectiveTps: 50 }));

  assert.equal(await app.app.tps.probeNow(routeA.id), true);
  assert.equal(await app.app.tps.probeNow(routeA.id), false, 'a short probe does not pass');
  assert.equal(app.app.tps.status(model).restore_streak, 1, 'the short probe kept the streak');
  assert.equal(await app.app.tps.probeNow(routeA.id), true);
  assert.equal(await app.app.tps.probeNow(routeA.id), true);
  assert.equal(app.app.tps.isDegraded(routeA.id), false);
});

test('probe 429 keeps the key usable', async (t) => {
  const upstreamA = await startStubUpstream((req, res) => jsonCompletion(res, { status: 429 }));
  const upstreamB = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'B' }));
  const { app, model, routeA, providerA } = await seedRoutes(upstreamA, upstreamB);
  await t.after(async () => {
    await app.close();
    await upstreamA.close();
    await upstreamB.close();
  });
  app.app.registry.updateModel(model.id, { tpsFloor: 1, preferredRouteId: routeA.id });
  const key = app.app.registry.keysByProvider.get(providerA.id)[0];
  assert.equal(await app.app.tps.probeNow(routeA.id), false);
  assert.equal(key.disabledUntil, 0, 'rate limits do not disable the key');
});

test('three successful probes restore the preferred route', async (t) => {
  const upstreamA = await startStubUpstream((req, res) => sseUsage(res, { contentTokens: 200 }));
  const upstreamB = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'B' }));
  const { app, model, routeA, raw } = await seedRoutes(upstreamA, upstreamB);
  await t.after(async () => {
    await app.close();
    await upstreamA.close();
    await upstreamB.close();
  });
  app.app.registry.updateModel(model.id, { tpsFloor: 100, preferredRouteId: routeA.id });
  for (let i = 0; i < 12; i += 1) app.app.tps.recordSample(routeA, sample({ effectiveTps: 50 }));
  assert.equal(app.app.tps.isDegraded(routeA.id), true);

  for (let i = 0; i < 2; i += 1) {
    assert.equal(await app.app.tps.probeNow(routeA.id), true, `probe ${i + 1} passes`);
    assert.equal(app.app.tps.isDegraded(routeA.id), true, 'two passes are not enough');
  }
  assert.equal(await app.app.tps.probeNow(routeA.id), true, 'third probe passes');
  assert.equal(app.app.tps.isDegraded(routeA.id), false, 'three passes restore the route');

  const result = await chat(app.baseUrl, raw, 'tps-model');
  assert.equal(result.status, 200);
  assert.equal(upstreamB.state.requests.length, 0, 'fallback was not used after restoration');
  assert.equal(upstreamA.state.requests.length, 4, 'three probes and one user request hit the preferred route');
});

test('failed probes keep the preferred route degraded', async (t) => {
  const upstreamA = await startStubUpstream((req, res) => sseUsage(res, { contentTokens: 500 }));
  const upstreamB = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'B' }));
  const { app, model, routeA } = await seedRoutes(upstreamA, upstreamB);
  await t.after(async () => {
    await app.close();
    await upstreamA.close();
    await upstreamB.close();
  });
  app.app.registry.updateModel(model.id, { tpsFloor: 1000000000, preferredRouteId: routeA.id });
  for (let i = 0; i < 12; i += 1) app.app.tps.recordSample(routeA, sample({ effectiveTps: 50 }));
  assert.equal(app.app.tps.isDegraded(routeA.id), true);

  for (let i = 0; i < 3; i += 1) {
    assert.equal(await app.app.tps.probeNow(routeA.id), false, 'probe stays below the restore threshold');
  }
  assert.equal(app.app.tps.isDegraded(routeA.id), true, 'failed probes do not restore');
});

test('probe falls back to non-streaming when streaming usage is missing', async (t) => {
  let calls = 0;
  const upstreamA = await startStubUpstream((req, res, entry) => {
    calls += 1;
    if (entry.body?.stream) {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
      res.end([
        frame({ choices: [{ delta: { content: 'code '.repeat(20) } }] }),
        frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        'data: [DONE]\n\n',
      ].join(''));
      return;
    }
    jsonCompletion(res, {
      content: 'x',
      usage: { prompt_tokens: 10, completion_tokens: 200, completion_tokens_details: { reasoning_tokens: 0 } },
    });
  });
  const upstreamB = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'B' }));
  const { app, model, routeA } = await seedRoutes(upstreamA, upstreamB);
  await t.after(async () => {
    await app.close();
    await upstreamA.close();
    await upstreamB.close();
  });
  app.app.registry.updateModel(model.id, { tpsFloor: 100, preferredRouteId: routeA.id });
  for (let i = 0; i < 12; i += 1) app.app.tps.recordSample(routeA, sample({ effectiveTps: 50 }));

  for (let i = 0; i < 3; i += 1) assert.equal(await app.app.tps.probeNow(routeA.id), true);
  assert.equal(app.app.tps.isDegraded(routeA.id), false, 'three fallback probes restored the route');
  assert.ok(calls >= 6, 'each probe used streaming and non-streaming attempts');
});

test('probe retries with a larger budget when content is short', async (t) => {
  let calls = 0;
  const upstreamA = await startStubUpstream((req, res) => {
    calls += 1;
    sseUsage(res, { contentTokens: calls === 1 ? 50 : 300 });
  });
  const upstreamB = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'B' }));
  const { app, model, routeA } = await seedRoutes(upstreamA, upstreamB);
  await t.after(async () => {
    await app.close();
    await upstreamA.close();
    await upstreamB.close();
  });
  app.app.registry.updateModel(model.id, { tpsFloor: 100, preferredRouteId: routeA.id });
  for (let i = 0; i < 12; i += 1) app.app.tps.recordSample(routeA, sample({ effectiveTps: 50 }));

  assert.equal(await app.app.tps.probeNow(routeA.id), true);
  assert.ok(calls >= 2, 'the short first probe was retried with a larger budget');
  assert.equal(app.app.tps.status(model).restore_streak, 1);
});

test('probe auth failures disable the key and missing keys fail safely', async (t) => {
  const upstreamA = await startStubUpstream((req, res) => jsonCompletion(res, { status: 401 }));
  const upstreamB = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'B' }));
  const { app, model, routeA, providerA } = await seedRoutes(upstreamA, upstreamB);
  await t.after(async () => {
    await app.close();
    await upstreamA.close();
    await upstreamB.close();
  });
  app.app.registry.updateModel(model.id, { tpsFloor: 1, preferredRouteId: routeA.id });
  const key = app.app.registry.keysByProvider.get(providerA.id)[0];
  assert.equal(await app.app.tps.probeNow(routeA.id), false);
  assert.ok(key.disabledUntil > Date.now(), '401 probes disable the key');

  app.app.registry.softDeleteProviderKey(key.id);
  assert.equal(await app.app.tps.probeNow(routeA.id), false, 'missing keys fail safely');
});

test('automatic probes respect probe_enabled and the hourly budget', async (t) => {
  const upstreamA = await startStubUpstream((req, res) => sseUsage(res, { contentTokens: 200 }));
  const upstreamB = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'B' }));
  const { app, model, routeA } = await seedRoutes(upstreamA, upstreamB);
  await t.after(async () => {
    await app.close();
    await upstreamA.close();
    await upstreamB.close();
  });
  app.app.registry.updateModel(model.id, {
    tpsFloor: 1000000000, preferredRouteId: routeA.id, tpsProbeIntervalMs: 60000,
  });
  for (let i = 0; i < 12; i += 1) app.app.tps.recordSample(routeA, sample({ effectiveTps: 50 }));
  assert.equal(app.app.tps.isDegraded(routeA.id), true);

  app.app.registry.setSetting('probe_enabled', false);
  await app.app.tps.tick(Date.now() + 120000);
  assert.equal(upstreamA.state.requests.length, 0, 'disabled probes do not run');

  app.app.registry.setSetting('probe_enabled', true);
  app.app.registry.setSetting('probe_budget_per_hour', 0);
  await app.app.tps.tick(Date.now() + 180000);
  assert.equal(upstreamA.state.requests.length, 0, 'a zero hourly budget blocks probes');

  app.app.registry.setSetting('probe_budget_per_hour', 12);
  await app.app.tps.tick(Date.now() + 240000);
  assert.equal(upstreamA.state.requests.length, 1, 'the next due probe runs');
});

test('stopping the controller aborts an in-flight probe', async (t) => {
  const upstreamA = await startStubUpstream(() => new Promise(() => {}));
  const upstreamB = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'B' }));
  const { app, model, routeA } = await seedRoutes(upstreamA, upstreamB);
  await t.after(async () => {
    await app.close();
    await upstreamA.close();
    await upstreamB.close();
  });
  app.app.registry.updateModel(model.id, { tpsFloor: 1, preferredRouteId: routeA.id });

  const pending = app.app.tps.probeNow(routeA.id);
  await sleep(50);
  app.app.tps.stop();
  assert.equal(await pending, false);
});
