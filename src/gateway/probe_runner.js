// Recovery and health-check probe runner for gateway routes.
import { buildUpstreamUrl } from './upstream_url.js';
import { pickKey } from './pools.js';
import { resolveDownstreamPrices, computeDownstreamCost } from './pricing.js';

// Creates the probe runner bound to the registry, telemetry, metrics, and FX.
export function createProbeRunner({ registry, config, telemetry, metrics, fx }) {
  // Runs a real minimal completion probe for a cooling or health-checked route.
  async function runProbe(route) {
    const provider = registry.providerById(route.providerId);
    const key = provider ? pickKey(registry, route.providerId, Date.now()) : null;
    if (!provider || !key) return false;
    const model = registry.modelById(route.modelId);
    const started = Date.now();
    try {
      const response = await fetch(buildUpstreamUrl(provider.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key.key}`,
          'user-agent': 'smolorchestrator/2.0',
        },
        body: JSON.stringify({
          model: route.upstreamModel,
          messages: [{ role: 'user', content: registry.setting('probe_prompt', config.probePrompt) }],
          max_tokens: registry.setting('probe_max_tokens', config.probeMaxTokens),
          temperature: 0,
          stream: false,
        }),
        signal: AbortSignal.timeout(registry.setting('idle_timeout_ms', config.idleTimeoutMs)),
      });
      const latencyMs = Date.now() - started;
      const text = await response.text().catch(() => '');
      let usage = null;
      try { usage = JSON.parse(text)?.usage ?? null; } catch { usage = null; }
      const cachedTokens = usage?.prompt_tokens_details?.cached_tokens
        ?? usage?.prompt_cache_hit_tokens ?? usage?.cache_read_input_tokens ?? 0;
      const inputTokens = usage?.prompt_tokens ?? 0;
      const outputTokens = usage?.completion_tokens ?? 0;
      const upstreamCost = Number.isFinite(Number(usage?.cost)) ? Number(usage.cost) : null;
      const currency = String(registry.setting('billing_currency', config.billingCurrency)).toUpperCase();
      const fxRate = await fx.rate(currency);
      const prices = model ? resolveDownstreamPrices(model, route, fxRate, currency) : null;
      const downstreamCost = prices
        ? computeDownstreamCost(prices, { inputTokens, outputTokens, cachedTokens }) ?? 0 : 0;
      metrics?.recordProbe({
        model: model?.name ?? 'unknown',
        provider: provider.name,
        ok: response.ok,
      });
      telemetry.queue({
        type: 'event', ts: Date.now(), routeId: route.id, providerKeyId: key.id,
        attempt: 1, status: response.status, latencyMs, inputTokens, outputTokens, cachedTokens,
        upstreamCost, downstreamCost, currency, fxRate,
        estCost: 0, savedCost: 0, isProbe: true, error: response.ok ? null : `probe status ${response.status}`,
      });
      return response.ok;
    } catch (error) {
      metrics?.recordProbe({
        model: registry.modelById(route.modelId)?.name ?? 'unknown',
        provider: provider.name,
        ok: false,
      });
      telemetry.queue({
        type: 'event', ts: Date.now(), routeId: route.id, providerKeyId: key.id,
        attempt: 1, status: 0, latencyMs: Date.now() - started, isProbe: true, error: error.message,
      });
      return false;
    }
  }

  return { runProbe };
}
