// TPS recovery probe runner: real provider requests, usage fallback, and abort handling.
import { createUsageExtractor } from './usage.js';
import { pickKey, disableKey } from './pools.js';
import { buildUpstreamUrl } from './upstream_url.js';
import { isValidTpsSample } from './tps_validity.js';
import { TPS_MIN_CONTENT_TOKENS, TPS_MAX_PROBE_TOKENS, TPS_COMPLETE_FINISH_REASONS } from '../util/tps_limits.js';

// Creates the probe runner bound to the registry, telemetry, metrics, and fetch implementation.
export function createTpsProbe({
  registry, config, telemetry, logger, metrics, fetchImpl = fetch, isStopped,
}) {
  const probing = new Set();
  const controllers = new Set();

  // Executes one probe HTTP attempt and extracts usage timing without retaining content.
  async function attemptProbe({ route, provider, key, stream, maxTokens }) {
    const startedPerf = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('tps_probe_timeout')), config.tpsProbeTimeoutMs);
    timeout.unref?.();
    controllers.add(controller);
    try {
      const response = await fetchImpl(buildUpstreamUrl(provider.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key.key}`,
          'user-agent': 'smolrouter/2.0',
        },
        body: JSON.stringify({
          model: route.upstreamModel,
          messages: [{ role: 'user', content: config.tpsProbePrompt }],
          max_tokens: maxTokens,
          temperature: 0,
          ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
        }),
        signal: controller.signal,
      });
      const latencyMs = Math.round(performance.now() - startedPerf);
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 401 || response.status === 403) {
          disableKey(key, Date.now(), registry.setting('key_disable_ms', config.keyDisableMs));
        }
        return { ok: false, status: response.status, latencyMs, error: `probe status ${response.status}` };
      }
      const contentType = response.headers.get('content-type') || '';
      const mode = stream && !contentType.includes('application/json') ? 'sse' : 'json';
      const extractor = createUsageExtractor({ mode, maxBytes: config.usageParseMaxBytes, startedPerf });
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          extractor.push(Buffer.from(value));
        }
      }
      const observed = extractor.result();
      const sample = observed ? {
        finishReason: observed.finishReason,
        contentTokens: observed.contentTokens,
        effectiveTps: observed.effectiveTps,
        contentTps: observed.contentTps,
        contentTtftMs: observed.contentTtftMs,
        contentGenerationMs: observed.contentGenerationMs,
        cachedTokens: observed.cachedTokens,
        inputTokens: observed.inputTokens,
        outputTokens: observed.outputTokens,
        upstreamCost: observed.upstreamCost,
      } : null;
      return { ok: true, status: response.status, latencyMs, observed, sample, mode };
    } catch (error) {
      return {
        ok: false, status: 0, latencyMs: Math.round(performance.now() - startedPerf),
        error: error.message, aborted: isStopped?.() === true,
      };
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
    }
  }

  // Queues one probe attempt for telemetry; probe rows never affect usage or budgets.
  function queueTelemetry(route, key, result, valid) {
    if (isStopped?.()) return;
    const sample = result.sample;
    telemetry?.queue({
      type: 'event', ts: Date.now(), modelId: route.modelId, routeId: route.id,
      providerKeyId: key?.id ?? null,
      attempt: 1, status: result.status ?? 0, latencyMs: result.latencyMs ?? 0,
      inputTokens: sample?.inputTokens ?? 0,
      outputTokens: sample?.outputTokens ?? 0,
      cachedTokens: sample?.cachedTokens ?? 0,
      estCost: 0, savedCost: 0, bytes: 0, estimated: !sample,
      isProbe: true,
      upstreamCost: sample?.upstreamCost ?? null,
      downstreamCost: 0,
      responseTokens: sample?.contentTokens ?? null,
      responseTtftMs: sample?.contentTtftMs ?? null,
      responseGenerationMs: sample?.contentGenerationMs ?? null,
      effectiveTps: valid ? sample?.effectiveTps ?? null : null,
      responseTps: sample?.contentTps ?? null,
      error: result.error ?? null,
    });
  }

  // Runs one probe, adding non-streaming and larger-budget fallbacks when needed.
  async function run(route, model) {
    if (probing.has(route.id)) return { skipped: true };
    if (isStopped?.()) return { skipped: true };
    probing.add(route.id);
    try {
      const provider = registry.providerById(route.providerId);
      const key = provider ? pickKey(registry, route.providerId, Date.now()) : null;
      if (!provider || !key) {
        queueTelemetry(route, null, { status: 0, latencyMs: 0, error: 'no provider key' }, false);
        metrics?.recordProbe({ model: model.name, provider: provider?.name ?? 'unknown', ok: false });
        logger?.warn('tps probe skipped', { routeId: route.id, reason: 'no provider key' });
        return { valid: false, measured: false, sample: null };
      }
      let result = await attemptProbe({
        route, provider, key, stream: true, maxTokens: config.tpsProbeMaxTokens,
      });
      if (result.ok && !result.observed && result.mode === 'sse') {
        if (isStopped?.()) return { valid: false, measured: false, sample: null };
        result = await attemptProbe({
          route, provider, key, stream: false, maxTokens: config.tpsProbeMaxTokens,
        });
      }
      let sample = result.sample;
      let valid = result.ok && isValidTpsSample(sample, {
        maxTtftMs: model.tpsMaxTtftMs, allowCached: true,
      });
      if (result.ok && sample && !valid
        && TPS_COMPLETE_FINISH_REASONS.has(sample.finishReason)
        && Number(sample.contentTokens) < TPS_MIN_CONTENT_TOKENS) {
        const retryMax = Math.min(config.tpsProbeMaxTokens * 2, TPS_MAX_PROBE_TOKENS);
        if (retryMax > config.tpsProbeMaxTokens) {
          if (isStopped?.()) return { valid: false, measured: false, sample: null };
          result = await attemptProbe({
            route, provider, key, stream: result.mode === 'sse', maxTokens: retryMax,
          });
          sample = result.sample;
          valid = result.ok && isValidTpsSample(sample, {
            maxTtftMs: model.tpsMaxTtftMs, allowCached: true,
          });
        }
      }
      queueTelemetry(route, key, result, valid);
      metrics?.recordProbe({ model: model.name, provider: provider.name, ok: valid });
      if (!valid) {
        logger?.warn('tps probe failed', {
          routeId: route.id, status: result.status ?? 0, error: result.error ?? 'invalid sample',
        });
      }
      return { valid, measured: Boolean(result.ok && sample), sample };
    } finally {
      probing.delete(route.id);
    }
  }

  // Aborts any in-flight probe request.
  function stop() {
    for (const controller of controllers) {
      try { controller.abort(new Error('tps_probe_stopped')); } catch { /* already aborted */ }
    }
    controllers.clear();
  }

  return { run, stop };
}
