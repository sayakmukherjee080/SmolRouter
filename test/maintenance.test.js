// Retention maintenance and flush-failure resilience.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from './helpers/app.js';
import { startStubUpstream, jsonCompletion } from './helpers/upstream.js';

test('retention prunes telemetry and usage but never audit rows', async (t) => {
  const upstream = await startStubUpstream((req, res) => jsonCompletion(res));
  const app = await createTestApp();
  const provider = app.addProvider('stub', upstream.baseUrl);
  const model = app.app.registry.createModel({ name: 'pruned' });
  const route = app.app.registry.createRoute({ modelId: model.id, providerId: provider.id, upstreamModel: 'u' });
  await t.after(async () => {
    await app.close();
    await upstream.close();
  });

  const old = Date.now() - 40 * 86400000;
  app.db.prepare(`INSERT INTO telemetry (ts, status, latency_ms) VALUES (?, 200, 1)`).run(old);
  app.db.prepare(`INSERT INTO usage (entity, entity_id, window_start, requests) VALUES ('model', ?, ?, 1)`)
    .run(model.id, old);
  app.db.prepare(`INSERT INTO audit (ts, action, outcome) VALUES (?, 'login', 'success')`).run(old);
  app.app.registry.setSetting('telemetry_retention_days', 1);
  app.app.registry.setSetting('usage_retention_days', 1);

  const result = app.app.maintenance.run();
  assert.equal(result.deletedTelemetry, 1);
  assert.equal(result.deletedUsage, 1);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS c FROM telemetry').get().c, 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS c FROM usage').get().c, 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS c FROM audit').get().c, 1, 'audit rows are append-only');
  assert.ok(route.id > 0);
});

test('current-month usage rows are never pruned', async (t) => {
  const app = await createTestApp();
  await t.after(() => app.close());

  const now = Date.now();
  const currentWindow = Math.floor(now / 86400000) * 86400000;
  app.db.prepare("INSERT INTO usage (entity, entity_id, window_start, requests) VALUES ('model', 1, ?, 1)").run(currentWindow);
  app.app.registry.setSetting('usage_retention_days', 1);
  const result = app.app.maintenance.run();
  assert.equal(result.deletedUsage, 0, 'current month survives even with a tiny retention window');
  assert.equal(app.db.prepare('SELECT COUNT(*) AS c FROM usage').get().c, 1);
});

test('token usage events inside an active budget window are never pruned', async (t) => {
  const app = await createTestApp();
  await t.after(() => app.close());

  const day = 86400000;
  const now = Date.now();
  const anchor = new Date(now - 52 * day).toISOString().slice(0, 10);
  const { token } = app.app.registry.createToken({
    label: 'long-window',
    budgetRules: [{ metric: 'tokens_total', period: 'n_days', period_count: 60, limit_value: 100000, anchor }],
  });
  const insert = app.db.prepare(`INSERT INTO token_usage_events
    (ts, token_id, requests, tokens_in, tokens_out, downstream_cost, currency, fx_rate, is_cache)
    VALUES (?, ?, 1, 1, 1, 0, 'USD', 1, 0)`);
  insert.run(now - 50 * day, token.id);
  insert.run(now - 70 * day, token.id);
  app.app.registry.setSetting('token_usage_retention_days', 32);

  app.app.maintenance.run();
  const remaining = app.db.prepare('SELECT ts FROM token_usage_events ORDER BY ts').all();
  assert.equal(remaining.length, 1, 'the event inside the active window survives');
  assert.equal(remaining[0].ts, now - 50 * day);
});

test('failed telemetry flush restores dirty route state', async (t) => {
  const app = await createTestApp();
  const provider = app.addProvider('stub', 'http://127.0.0.1:1/v1');
  const model = app.app.registry.createModel({ name: 'dirty' });
  const route = app.app.registry.createRoute({ modelId: model.id, providerId: provider.id, upstreamModel: 'u' });
  await t.after(() => app.close());

  route.consecutiveFailures = 3;
  app.app.registry.markRouteDirty(route);
  app.app.telemetry.queue({ type: 'event', ts: Date.now(), status: 200, latencyMs: 1 });
  const original = app.app.telemetry.insertEvent;
  app.app.telemetry.insertEvent = { run() { throw new Error('forced flush failure'); } };
  await app.app.telemetry.flush();
  assert.ok(app.app.registry.dirtyRoutes.has(route.id), 'dirty state retained after failure');

  app.app.telemetry.insertEvent = original;
  await app.app.telemetry.flush();
  const row = app.db.prepare('SELECT consecutive_failures FROM routes WHERE id = ?').get(route.id);
  assert.equal(row.consecutive_failures, 3, 'state persisted on the next flush');
});
