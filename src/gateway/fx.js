// Cached USD-to-billing-currency conversion for downstream prices and budgets.
const DEFAULT_FX_MAX_STALE_MS = 86400000;

export function createFx({ config, registry, fetchImpl = fetch }) {
  const cached = new Map();
  const pending = new Map();

  // Returns the configured billing currency.
  function currency() {
    return String(registry.setting('billing_currency', config.billingCurrency)).toUpperCase();
  }

  // Returns the maximum age of a cached rate after refresh failures.
  function maxStaleMs() {
    return registry.setting('fx_max_stale_ms', config.fxMaxStaleMs ?? DEFAULT_FX_MAX_STALE_MS);
  }

  // Fetches one rate and updates the cache.
  async function fetchRate(wanted, now) {
    let url;
    try {
      url = new URL(config.fxApiUrl);
    } catch {
      return null;
    }
    url.searchParams.set('from', 'USD');
    url.searchParams.set('to', wanted);
    if (config.fxApiKey) url.searchParams.set('apikey', config.fxApiKey);
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(3000),
        headers: config.fxApiKey ? { 'x-api-key': config.fxApiKey } : {},
      });
      const payload = await response.json();
      const value = Number(payload?.rates?.[wanted]);
      if (!response.ok || !Number.isFinite(value) || value <= 0) throw new Error('invalid fx response');
      const ttl = registry.setting('fx_cache_ttl_ms', config.fxCacheTtlMs);
      cached.set(wanted, { rate: value, fetchedAt: now, expiresAt: now + ttl });
      return value;
    } catch {
      const previous = cached.get(wanted);
      if (previous && now - previous.fetchedAt <= maxStaleMs()) return previous.rate;
      return null;
    }
  }

  // Returns a cached or freshly fetched conversion rate, or null when unavailable.
  async function rate(target = null) {
    const wanted = String(target || currency()).toUpperCase();
    if (wanted === 'USD') return 1;
    const now = Date.now();
    const entry = cached.get(wanted);
    if (entry && now < entry.expiresAt) return entry.rate;
    if (pending.has(wanted)) return pending.get(wanted);
    const promise = fetchRate(wanted, now).finally(() => pending.delete(wanted));
    pending.set(wanted, promise);
    return promise;
  }

  return { rate, currency };
}
