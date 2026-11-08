// FX conversion caching and fallback behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFx } from '../src/gateway/fx.js';

// Builds a fake registry with configurable settings.
function registryWith(settings = {}) {
  return { setting: (key, fallback) => (key in settings ? settings[key] : fallback) };
}

test('converts and caches rates, passes through USD, and falls back to the last rate', async () => {
  let calls = 0;
  let fail = false;
  const fetchImpl = async () => {
    calls += 1;
    if (fail) throw new Error('fx down');
    return new Response(JSON.stringify({ rates: { INR: 83 } }), { status: 200 });
  };
  const fx = createFx({
    config: { billingCurrency: 'USD', fxApiUrl: 'https://fx.test/latest', fxApiKey: '', fxCacheTtlMs: 60000 },
    registry: registryWith({ billing_currency: 'INR', fx_cache_ttl_ms: 60000 }),
    fetchImpl,
  });

  assert.equal(await fx.rate(), 83);
  assert.equal(await fx.rate(), 83);
  assert.equal(calls, 1, 'second call uses the cache');

  const passthrough = createFx({
    config: { billingCurrency: 'USD', fxApiUrl: 'https://fx.test/latest', fxApiKey: '', fxCacheTtlMs: 60000 },
    registry: registryWith({ billing_currency: 'USD' }),
    fetchImpl,
  });
  assert.equal(await passthrough.rate(), 1);
  assert.equal(calls, 1, 'USD never calls the FX API');

  const flaky = createFx({
    config: { billingCurrency: 'USD', fxApiUrl: 'https://fx.test/latest', fxApiKey: '', fxCacheTtlMs: 60000 },
    registry: registryWith({ billing_currency: 'INR', fx_cache_ttl_ms: 0 }),
    fetchImpl,
  });
  assert.equal(await flaky.rate(), 83);
  fail = true;
  assert.equal(await flaky.rate(), 83, 'stale cached rate survives an API failure');
});

test('concurrent misses share one fetch and currencies cache independently', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    const target = new URL(url).searchParams.get('to');
    return new Response(JSON.stringify({ rates: { [target]: target === 'INR' ? 83 : 2 } }), { status: 200 });
  };
  const fx = createFx({
    config: { billingCurrency: 'USD', fxApiUrl: 'https://fx.test/latest', fxApiKey: '', fxCacheTtlMs: 60000, fxMaxStaleMs: 60000 },
    registry: registryWith({ billing_currency: 'INR', fx_cache_ttl_ms: 60000, fx_max_stale_ms: 60000 }),
    fetchImpl,
  });

  const [first, second] = await Promise.all([fx.rate('INR'), fx.rate('INR')]);
  assert.equal(first, 83);
  assert.equal(second, 83);
  assert.equal(calls, 1, 'concurrent callers share the in-flight request');
  assert.equal(await fx.rate('EUR'), 2);
  assert.equal(calls, 2, 'each target currency caches independently');
  assert.equal(await fx.rate('EUR'), 2);
  assert.equal(calls, 2);
});

test('rates older than the maximum stale age are not served', async () => {
  let fail = false;
  const fetchImpl = async () => {
    if (fail) throw new Error('fx down');
    return new Response(JSON.stringify({ rates: { INR: 83 } }), { status: 200 });
  };
  const fx = createFx({
    config: { billingCurrency: 'USD', fxApiUrl: 'https://fx.test/latest', fxApiKey: '', fxCacheTtlMs: 0, fxMaxStaleMs: 1 },
    registry: registryWith({ billing_currency: 'INR', fx_cache_ttl_ms: 0, fx_max_stale_ms: 1 }),
    fetchImpl,
  });

  assert.equal(await fx.rate(), 83);
  fail = true;
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await fx.rate(), null, 'an expired stale rate is rejected');
});
