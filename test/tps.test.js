// TPS routing core: sampling, validity, demotion, hydration, and non-streaming traffic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { adminLogin, waitFor } from './helpers/app.js';
import { startStubUpstream, jsonCompletion } from './helpers/upstream.js';
import { createUsageExtractor } from '../src/gateway/usage.js';
import { isValidTpsSample } from '../src/gateway/tps_validity.js';
import { chat, sample, sseUsage, seedRoutes, sleep } from './helpers/tps.js';

test('usage extractor measures response tokens, timing, and reasoning exclusion', async () => {
  const startedPerf = performance.now();
  const extractor = createUsageExtractor({ mode: 'sse', maxBytes: 1024, startedPerf });
  const frame = (payload) => Buffer.from(`data: ${JSON.stringify(payload)}\n\n`);
  extractor.push(frame({ choices: [{ delta: { content: 'a' } }] }));
  await new Promise((resolve) => setTimeout(resolve, 25));
  extractor.push(frame({ choices: [{ delta: { content: 'b' } }] }));
  await new Promise((resolve) => setTimeout(resolve, 25));
  extractor.push(frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
  extractor.push(frame({
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 250, completion_tokens_details: { reasoning_tokens: 50 } },
  }));
  const observed = extractor.result();
  assert.equal(observed.contentTokens, 200, 'reasoning tokens are excluded');
  assert.equal(observed.finishReason, 'stop');
  assert.ok(observed.contentTtftMs >= 0);
  assert.ok(observed.contentGenerationMs >= 20);
  assert.ok(observed.contentTps > 0);
  assert.ok(observed.effectiveTps > 0);
  assert.equal(isValidTpsSample(observed), true);
});

test('invalid samples are excluded from TPS routing', () => {
  assert.equal(isValidTpsSample(sample({ finishReason: 'length' })), false);
  assert.equal(isValidTpsSample(sample({ contentTokens: 99 })), false);
  assert.equal(isValidTpsSample(sample({ effectiveTps: 0 })), false);
  assert.equal(isValidTpsSample(null), false);
  assert.equal(isValidTpsSample(sample({ finishReason: 'end_turn' })), true, 'normalized terminal reasons are accepted');
});

test('TTFT and provider cache gates apply to user samples', async (t) => {
  const upstreamA = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'A' }));
  const upstreamB = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'B' }));
  const { app, model, routeA } = await seedRoutes(upstreamA, upstreamB);
  await t.after(async () => {
    await app.close();
    await upstreamA.close();
    await upstreamB.close();
  });
  app.app.registry.updateModel(model.id, {
    tpsFloor: 100,
    preferredRouteId: routeA.id,
    tpsMaxTtftMs: 1000,
  });

  assert.equal(
    app.app.tps.recordSample(routeA, sample({ effectiveTps: 200, contentTtftMs: 2000 })),
    false,
    'samples above the TTFT limit are rejected',
  );
  assert.equal(
    app.app.tps.recordSample(routeA, sample({ effectiveTps: 200, contentTtftMs: 500, cachedTokens: 10 })),
    false,
    'provider-cached user samples are rejected',
  );
  assert.equal(
    app.app.tps.recordSample(routeA, sample({ effectiveTps: 200, contentTtftMs: 500 })),
    true,
  );
  assert.equal(app.app.tps.status(model).sample_count, 1);
  assert.equal(
    isValidTpsSample(sample({ cachedTokens: 10 }), { allowCached: true }),
    true,
    'probes may reuse a cached prompt',
  );
});

test('usage extractor recognizes array content deltas', async () => {
  const startedPerf = performance.now();
  const extractor = createUsageExtractor({ mode: 'sse', maxBytes: 1024, startedPerf });
  const frame = (payload) => Buffer.from(`data: ${JSON.stringify(payload)}\n\n`);
  extractor.push(frame({ choices: [{ delta: { content: [{ type: 'text', text: 'a' }] } }] }));
  await sleep(20);
  extractor.push(frame({ choices: [{ delta: { content: [{ type: 'text', text: 'b' }] } }] }));
  extractor.push(frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
  extractor.push(frame({
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 200, completion_tokens_details: { reasoning_tokens: 0 } },
  }));
  const observed = extractor.result();
  assert.equal(observed.contentTokens, 200);
  assert.ok(observed.contentTtftMs >= 0);
  assert.ok(observed.contentGenerationMs >= 10);
  assert.equal(isValidTpsSample(observed), true);
});

test('preferred route demotes after 10 of 12 low samples and falls back', async (t) => {
  const upstreamA = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'A' }));
  const upstreamB = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'B' }));
  const { app, model, routeA, raw } = await seedRoutes(upstreamA, upstreamB);
  await t.after(async () => {
    await app.close();
    await upstreamA.close();
    await upstreamB.close();
  });
  app.app.registry.updateModel(model.id, { tpsFloor: 100, preferredRouteId: routeA.id });

  for (let i = 0; i < 10; i += 1) app.app.tps.recordSample(routeA, sample({ effectiveTps: 50 }));
  for (let i = 0; i < 2; i += 1) app.app.tps.recordSample(routeA, sample({ effectiveTps: 200 }));
  assert.equal(app.app.tps.isDegraded(routeA.id), true, '10 of 12 below floor demotes');

  const result = await chat(app.baseUrl, raw, 'tps-model');
  assert.equal(result.status, 200);
  assert.equal(upstreamA.state.requests.length, 0, 'degraded preferred route is skipped');
  assert.equal(upstreamB.state.requests.length, 1, 'fallback route served the request');
});

test('real streaming samples demote through the full request path', async (t) => {
  const upstreamA = await startStubUpstream((req, res) => {
    setTimeout(() => sseUsage(res, { contentTokens: 200 }), 20);
  });
  const upstreamB = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'B' }));
  const { app, model, routeA, raw } = await seedRoutes(upstreamA, upstreamB);
  await t.after(async () => {
    await app.close();
    await upstreamA.close();
    await upstreamB.close();
  });
  app.app.registry.updateModel(model.id, { tpsFloor: 1000000, preferredRouteId: routeA.id });

  for (let i = 0; i < 12; i += 1) {
    const result = await chat(app.baseUrl, raw, 'tps-model');
    assert.equal(result.status, 200);
  }
  const status = app.app.tps.status(model);
  assert.equal(status.sample_count, 12, 'streaming responses produced valid TPS samples');
  assert.equal(status.below_floor, 12, 'every sample is below the high test floor');
  assert.equal(status.degraded, true, 'the preferred route is demoted');

  const fallback = await chat(app.baseUrl, raw, 'tps-model');
  assert.equal(fallback.status, 200);
  assert.equal(upstreamA.state.requests.length, 12, 'preferred route served the first twelve requests');
  assert.equal(upstreamB.state.requests.length, 1, 'the next request used the fallback route');

  await app.flush();
  const session = await adminLogin(app.baseUrl);
  const usageResponse = await fetch(`${app.baseUrl}/api/v1/usage`, { headers: { cookie: session.cookie } });
  const usageBody = await usageResponse.json();
  const tpsRow = usageBody.data.tps.find((row) => row.routeId === routeA.id);
  assert.ok(tpsRow, 'the usage report includes a TPS row');
  assert.ok(tpsRow.samples >= 12);
  assert.ok(Number.isFinite(tpsRow.effectiveTps));
});

test('9 of 12 low samples does not demote', async (t) => {
  const upstreamA = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'A' }));
  const upstreamB = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'B' }));
  const { app, model, routeA } = await seedRoutes(upstreamA, upstreamB);
  await t.after(async () => {
    await app.close();
    await upstreamA.close();
    await upstreamB.close();
  });
  app.app.registry.updateModel(model.id, { tpsFloor: 100, preferredRouteId: routeA.id });

  for (let i = 0; i < 9; i += 1) app.app.tps.recordSample(routeA, sample({ effectiveTps: 50 }));
  for (let i = 0; i < 3; i += 1) app.app.tps.recordSample(routeA, sample({ effectiveTps: 200 }));
  assert.equal(app.app.tps.isDegraded(routeA.id), false, '9 below floor keeps the route');

  for (let i = 0; i < 10; i += 1) app.app.tps.recordSample(routeA, sample({ effectiveTps: 50 }));
  assert.equal(app.app.tps.isDegraded(routeA.id), true, 'the tenth low sample in the window demotes');
});

test('floor changes reconcile existing samples immediately', async (t) => {
  const upstreamA = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'A' }));
  const upstreamB = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'B' }));
  const { app, model, routeA } = await seedRoutes(upstreamA, upstreamB);
  await t.after(async () => {
    await app.close();
    await upstreamA.close();
    await upstreamB.close();
  });
  app.app.registry.updateModel(model.id, { tpsFloor: 1, preferredRouteId: routeA.id });
  for (let i = 0; i < 12; i += 1) app.app.tps.recordSample(routeA, sample({ effectiveTps: 50 }));
  assert.equal(app.app.tps.isDegraded(routeA.id), false);

  app.app.registry.updateModel(model.id, { tpsFloor: 100 });
  app.app.tps.syncModel(app.app.registry.modelById(model.id));
  assert.equal(app.app.tps.isDegraded(routeA.id), true, 'raising the floor demotes immediately');

  app.app.registry.updateModel(model.id, { tpsFloor: 1 });
  app.app.tps.syncModel(app.app.registry.modelById(model.id));
  assert.equal(app.app.tps.isDegraded(routeA.id), false, 'lowering the floor clears the degraded state');
});

test('TPS-aware routing bypasses cache-aware pins', async (t) => {
  const upstreamA = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'A' }));
  const upstreamB = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'B' }));
  const { app, model, routeA, raw } = await seedRoutes(upstreamA, upstreamB, { balanceStrategy: 'cache_aware' });
  await t.after(async () => {
    await app.close();
    await upstreamA.close();
    await upstreamB.close();
  });
  app.app.registry.updateModel(model.id, { tpsFloor: 100, preferredRouteId: routeA.id });
  for (let i = 0; i < 12; i += 1) app.app.tps.recordSample(routeA, sample({ effectiveTps: 50 }));
  app.app.gateway.pins.set(1, model.id, routeA.id, 1);

  const result = await chat(app.baseUrl, raw, 'tps-model');
  assert.equal(result.status, 200);
  assert.equal(upstreamB.state.requests.length, 1, 'fallback wins despite a stale pin');
  assert.equal(upstreamA.state.requests.length, 0);
});

test('startup hydration marks a preferred route degraded from telemetry', async (t) => {
  const upstreamA = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'A' }));
  const upstreamB = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'B' }));
  const { app, model, routeA } = await seedRoutes(upstreamA, upstreamB);
  await t.after(async () => {
    await app.close();
    await upstreamA.close();
    await upstreamB.close();
  });
  app.app.registry.updateModel(model.id, { tpsFloor: 100, preferredRouteId: routeA.id });
  const insert = app.db.prepare(`INSERT INTO telemetry
    (ts, model_id, route_id, status, latency_ms, effective_tps, response_tokens, response_tps, is_probe)
    VALUES (?, ?, ?, 200, 1000, 50, 200, 50, 0)`);
  for (let i = 0; i < 12; i += 1) insert.run(Date.now() - i * 1000, model.id, routeA.id);

  app.app.tps.syncModel(model);
  assert.equal(app.app.tps.isDegraded(routeA.id), true, 'recent low samples demote when TPS is enabled');
  app.app.tps.reload();
  assert.equal(app.app.tps.isDegraded(routeA.id), true, 'recent low samples demote on hydration');
});

test('non-streaming responses feed TPS samples', async (t) => {
  const upstreamA = await startStubUpstream((req, res) => jsonCompletion(res, {
    content: 'A',
    usage: { prompt_tokens: 10, completion_tokens: 200, completion_tokens_details: { reasoning_tokens: 0 } },
  }));
  const upstreamB = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'B' }));
  const { app, model, routeA, raw } = await seedRoutes(upstreamA, upstreamB);
  await t.after(async () => {
    await app.close();
    await upstreamA.close();
    await upstreamB.close();
  });
  app.app.registry.updateModel(model.id, { tpsFloor: 100, preferredRouteId: routeA.id });

  const result = await chat(app.baseUrl, raw, 'tps-model');
  assert.equal(result.status, 200);
  await waitFor(() => app.app.tps.status(model).sample_count === 1);
  const status = app.app.tps.status(model);
  assert.equal(status.sample_count, 1);
  assert.ok(Number.isFinite(status.effective_tps));
});

test('route repoint excludes pre-reset telemetry on hydration', async (t) => {
  const upstreamA = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'A' }));
  const upstreamB = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'B' }));
  const { app, model, routeA } = await seedRoutes(upstreamA, upstreamB);
  await t.after(async () => {
    await app.close();
    await upstreamA.close();
    await upstreamB.close();
  });
  app.app.registry.updateModel(model.id, { tpsFloor: 100, preferredRouteId: routeA.id });
  const insert = app.db.prepare(`INSERT INTO telemetry
    (ts, model_id, route_id, status, latency_ms, effective_tps, response_tokens, response_tps,
     cached_tokens, is_probe)
    VALUES (?, ?, ?, 200, 1000, 50, 200, 50, 0, 0)`);
  for (let i = 0; i < 12; i += 1) insert.run(Date.now() - 1000, model.id, routeA.id);

  app.app.registry.updateRoute(routeA.id, { upstreamModel: 'ua-repointed' });
  app.app.tps.reload();
  assert.equal(app.app.tps.isDegraded(routeA.id), false, 'pre-reset samples are ignored');

  const afterReset = Date.now() + 1000;
  for (let i = 0; i < 12; i += 1) insert.run(afterReset, model.id, routeA.id);
  app.app.tps.reload();
  assert.equal(app.app.tps.isDegraded(routeA.id), true, 'post-reset samples still demote');
});

test('hydration respects the TTFT gate', async (t) => {
  const upstreamA = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'A' }));
  const upstreamB = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'B' }));
  const { app, model, routeA } = await seedRoutes(upstreamA, upstreamB);
  await t.after(async () => {
    await app.close();
    await upstreamA.close();
    await upstreamB.close();
  });
  app.app.registry.updateModel(model.id, { tpsFloor: 100, preferredRouteId: routeA.id, tpsMaxTtftMs: 1000 });
  const insert = app.db.prepare(`INSERT INTO telemetry
    (ts, model_id, route_id, status, latency_ms, effective_tps, response_tokens, response_tps,
     response_ttft_ms, cached_tokens, is_probe)
    VALUES (?, ?, ?, 200, 1000, 50, 200, 50, ?, 0, 0)`);
  for (let i = 0; i < 12; i += 1) insert.run(Date.now() - i * 1000, model.id, routeA.id, 5000);
  app.app.tps.reload();
  assert.equal(app.app.tps.isDegraded(routeA.id), false, 'samples above the TTFT limit are ignored');

  for (let i = 0; i < 12; i += 1) insert.run(Date.now(), model.id, routeA.id, 500);
  app.app.tps.reload();
  assert.equal(app.app.tps.isDegraded(routeA.id), true, 'samples inside the TTFT limit demote');
});

test('model validation rejects bad TPS settings and route deletion clears preference', async (t) => {
  const upstreamA = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'A' }));
  const upstreamB = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'B' }));
  const { app, model, routeA } = await seedRoutes(upstreamA, upstreamB);
  const other = app.app.registry.createModel({ name: 'other-model' });
  const otherRoute = app.app.registry.createRoute({
    modelId: other.id, providerId: app.app.registry.routesForModel(model.id)[1].providerId, upstreamModel: 'ub',
  });
  await t.after(async () => {
    await app.close();
    await upstreamA.close();
    await upstreamB.close();
  });

  assert.throws(() => app.app.registry.updateModel(model.id, { tpsFloor: 0 }), /tps_floor/);
  assert.throws(() => app.app.registry.updateModel(model.id, { tpsProbeIntervalMs: 1000 }), /tps_probe_interval_ms/);
  assert.throws(() => app.app.registry.updateModel(model.id, { tpsMaxTtftMs: -1 }), /tps_max_ttft_ms/);
  assert.throws(
    () => app.app.registry.updateModel(model.id, { preferredRouteId: otherRoute.id }),
    /preferred_route_id/,
  );

  app.app.registry.updateModel(model.id, { tpsFloor: 100, preferredRouteId: routeA.id });
  assert.equal(app.app.registry.modelById(model.id).preferredRouteId, routeA.id);
  app.app.registry.softDeleteRoute(routeA.id);
  assert.equal(app.app.registry.modelById(model.id).preferredRouteId, null, 'deleting a route clears the preference');
});
