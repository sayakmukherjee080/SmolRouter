// Retry-After handling for 429/503 route failures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from './helpers/app.js';
import { startStubUpstream } from './helpers/upstream.js';

test('Retry-After extends the route cooldown', async (t) => {
  const upstream = await startStubUpstream((req, res) => {
    res.statusCode = 429;
    res.setHeader('content-type', 'application/json');
    res.setHeader('retry-after', '1');
    res.end(JSON.stringify({ error: { message: 'slow down' } }));
  });
  const app = await createTestApp();
  const provider = app.addProvider('limited', upstream.baseUrl);
  const model = app.app.registry.createModel({ name: 'limited' });
  const route = app.app.registry.createRoute({ modelId: model.id, providerId: provider.id, upstreamModel: 'u' });
  app.app.registry.setSetting('backoff_base_ms', 1000);
  app.app.registry.setSetting('backoff_cap_ms', 5000);
  const { raw } = app.addToken('client', [model.id]);
  await t.after(async () => {
    await app.close();
    await upstream.close();
  });

  const before = Date.now();
  const response = await fetch(`${app.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${raw}` },
    body: JSON.stringify({ model: 'limited', messages: [] }),
  });
  await response.text();
  assert.equal(response.status, 502);
  const updated = app.app.registry.routeByIdOrNull(route.id);
  assert.ok(updated.cooldownUntil - before >= 900, 'Retry-After honoured');
  assert.ok(updated.cooldownUntil - before < 3000, 'cooldown bounded');
});
