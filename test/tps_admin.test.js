// TPS admin behavior: route/provider resets, model API fields, manual probes, and bundles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startStubUpstream, jsonCompletion } from './helpers/upstream.js';
import { createTestApp, adminLogin } from './helpers/app.js';
import { seedRoutes, sample, sseUsage } from './helpers/tps.js';
import { exportBundle, importBundle } from '../src/store/configBundle.js';

test('route edits preserve TPS unless repointed; provider URL changes reset it', async (t) => {
  const upstreamA = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'A' }));
  const upstreamB = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'B' }));
  const { app, model, routeA, providerA } = await seedRoutes(upstreamA, upstreamB);
  await t.after(async () => {
    await app.close();
    await upstreamA.close();
    await upstreamB.close();
  });
  app.app.registry.updateModel(model.id, { tpsFloor: 100, preferredRouteId: routeA.id });
  for (let i = 0; i < 12; i += 1) app.app.tps.recordSample(routeA, sample({ effectiveTps: 50 }));
  assert.equal(app.app.tps.isDegraded(routeA.id), true);
  const session = await adminLogin(app.baseUrl);
  const headers = { 'content-type': 'application/json', cookie: session.cookie, 'x-csrf-token': session.csrf };

  const priorityEdit = await fetch(`${app.baseUrl}/api/v1/routes/${routeA.id}`, {
    method: 'PATCH', headers, body: JSON.stringify({ priority: 5 }),
  });
  assert.equal(priorityEdit.status, 200);
  assert.equal(app.app.tps.isDegraded(routeA.id), true, 'priority-only edits keep TPS state');
  assert.equal(routeA.tpsResetAt, 0);

  const repoint = await fetch(`${app.baseUrl}/api/v1/routes/${routeA.id}`, {
    method: 'PATCH', headers, body: JSON.stringify({ upstreamModel: 'ua-repointed' }),
  });
  assert.equal(repoint.status, 200);
  assert.equal(app.app.tps.isDegraded(routeA.id), false, 'repointing clears TPS state');
  assert.ok(routeA.tpsResetAt > 0, 'repointing records a reset marker');

  for (let i = 0; i < 12; i += 1) app.app.tps.recordSample(routeA, sample({ effectiveTps: 50 }));
  assert.equal(app.app.tps.isDegraded(routeA.id), true);
  const providerEdit = await fetch(`${app.baseUrl}/api/v1/providers/${providerA.id}`, {
    method: 'PATCH', headers, body: JSON.stringify({ baseUrl: 'http://127.0.0.1:9/v1' }),
  });
  assert.equal(providerEdit.status, 200);
  assert.equal(app.app.tps.isDegraded(routeA.id), false, 'provider URL changes clear TPS state');
  assert.ok(routeA.tpsResetAt > 0);
});

test('provider deletion clears the TPS preference and state', async (t) => {
  const upstreamA = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'A' }));
  const upstreamB = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'B' }));
  const { app, model, routeA, providerA } = await seedRoutes(upstreamA, upstreamB);
  await t.after(async () => {
    await app.close();
    await upstreamA.close();
    await upstreamB.close();
  });
  app.app.registry.updateModel(model.id, { tpsFloor: 100, preferredRouteId: routeA.id });
  for (let i = 0; i < 12; i += 1) app.app.tps.recordSample(routeA, sample({ effectiveTps: 50 }));
  assert.equal(app.app.tps.isDegraded(routeA.id), true);

  const session = await adminLogin(app.baseUrl);
  const deleted = await fetch(`${app.baseUrl}/api/v1/providers/${providerA.id}`, {
    method: 'DELETE',
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
  });
  assert.equal(deleted.status, 200);
  assert.equal(app.app.registry.modelById(model.id).preferredRouteId, null);
  assert.equal(app.app.tps.isDegraded(routeA.id), false);
});

test('admin model API exposes and validates TPS settings', async (t) => {
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
  const session = await adminLogin(app.baseUrl);
  const patch = (body) => fetch(`${app.baseUrl}/api/v1/models/${model.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: session.cookie, 'x-csrf-token': session.csrf },
    body: JSON.stringify(body),
  });

  const saved = await patch({
    tpsFloor: 120, preferredRouteId: routeA.id, tpsProbeIntervalMs: 300000, tpsMaxTtftMs: 5000,
  });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  assert.equal(savedBody.data.tpsFloor, 120);
  assert.equal(savedBody.data.tpsMaxTtftMs, 5000);
  assert.equal(savedBody.data.preferredRouteId, routeA.id);

  const listed = await fetch(`${app.baseUrl}/api/v1/models`, { headers: { cookie: session.cookie } });
  const listedBody = await listed.json();
  const listedModel = listedBody.data.models.find((entry) => entry.id === model.id);
  assert.equal(listedModel.tps.enabled, true);
  assert.equal(listedModel.tps.preferred_route_id, routeA.id);
  assert.equal(listedModel.tps.tps_floor, 120);
  assert.equal(listedModel.tps.max_ttft_ms, 5000);
  assert.equal(listedModel.tps.probe_interval_ms, 300000);
  assert.equal(typeof listedModel.tps.probes_enabled, 'boolean');

  const rejected = await patch({ preferredRouteId: otherRoute.id });
  assert.equal(rejected.status, 422, 'a route of another model is rejected');

  const disabled = await patch({ preferredRouteId: null, tpsFloor: null });
  assert.equal(disabled.status, 200);
  const disabledBody = await disabled.json();
  assert.equal(disabledBody.data.preferredRouteId, null);
  assert.equal(disabledBody.data.tpsFloor, null);
});

test('manual TPS probe endpoint works and reports disabled TPS', async (t) => {
  const upstreamA = await startStubUpstream((req, res) => sseUsage(res, { contentTokens: 200 }));
  const upstreamB = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'B' }));
  const { app, model, routeA } = await seedRoutes(upstreamA, upstreamB);
  await t.after(async () => {
    await app.close();
    await upstreamA.close();
    await upstreamB.close();
  });
  const session = await adminLogin(app.baseUrl);
  const headers = { 'content-type': 'application/json', cookie: session.cookie, 'x-csrf-token': session.csrf };

  const disabled = await fetch(`${app.baseUrl}/api/v1/models/${model.id}/tps/probe`, { method: 'POST', headers });
  assert.equal(disabled.status, 200);
  const disabledBody = await disabled.json();
  assert.equal(disabledBody.data.probed, false);
  assert.equal(disabledBody.data.reason, 'tps_disabled');

  app.app.registry.updateModel(model.id, { tpsFloor: 1, preferredRouteId: routeA.id });
  const probed = await fetch(`${app.baseUrl}/api/v1/models/${model.id}/tps/probe`, { method: 'POST', headers });
  assert.equal(probed.status, 200);
  const probedBody = await probed.json();
  assert.equal(probedBody.data.probed, true);
  assert.equal(probedBody.data.passed, true);

  const unauthenticated = await fetch(`${app.baseUrl}/api/v1/models/${model.id}/tps/probe`, { method: 'POST' });
  assert.equal(unauthenticated.status, 401);
});

test('config bundles preserve TPS routing settings', async (t) => {
  const upstreamA = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'A' }));
  const upstreamB = await startStubUpstream((req, res) => jsonCompletion(res, { content: 'B' }));
  const { app, model, routeA } = await seedRoutes(upstreamA, upstreamB);
  const fresh = await createTestApp();
  await t.after(async () => {
    await app.close();
    await fresh.close();
    await upstreamA.close();
    await upstreamB.close();
  });
  app.app.registry.updateModel(model.id, {
    tpsFloor: 120,
    preferredRouteId: routeA.id,
    tpsProbeIntervalMs: 300000,
    tpsMaxTtftMs: 2000,
  });
  const bundle = exportBundle(app.app.registry);
  const result = importBundle(fresh.app.registry, bundle);
  assert.equal(result.created.models, 1);

  const imported = fresh.app.registry.modelByName('tps-model');
  assert.equal(imported.tpsFloor, 120);
  assert.equal(imported.tpsProbeIntervalMs, 300000);
  assert.equal(imported.tpsMaxTtftMs, 2000);
  assert.ok(imported.preferredRouteId, 'preferred route is restored');
  const importedRoute = fresh.app.registry.routeByIdOrNull(imported.preferredRouteId);
  assert.equal(importedRoute.upstreamModel, 'ua');
});
