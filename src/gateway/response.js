// Upstream response streaming, bounded capture, usage extraction, and cost finalisation.
import { buildClientResponseHeaders } from '../util/headers.js';
import { applySuccess } from './cooldown.js';
import { createUsageExtractor, estimateTokens } from './usage.js';
import { isValidTpsSample } from './tps_validity.js';
import { resolveRouteCost, computeDownstreamCost } from './pricing.js';

// Determines the usage extractor mode for a response content type.
function extractorMode(contentType) {
  if (!contentType) return 'none';
  if (contentType.includes('text/event-stream')) return 'sse';
  if (contentType.includes('application/json')) return 'json';
  return 'none';
}

// Creates the accepted-response handler bound to registry, telemetry, and metrics.
export function createResponseHandler({ registry, config, telemetry, logger, metrics, tps, onRouteStateChange }) {
  // Streams or captures an accepted upstream response while extracting usage.
  async function passThrough({
    request, upstream, route, provider, key, token, model, attempt, latencyMs, startedPerf,
    watchdog, onClientAbort, countUsage, capture, fxRate, currency, prices, settle, abandon,
  }) {
    const now = Date.now();
    const mode = extractorMode(upstream.headers.get('content-type'));
    const requestBytes = Number(request.headers.get('content-length')) || 0;
    const parseMax = registry.setting('usage_parse_max_bytes', config.usageParseMaxBytes);
    const release = () => {
      watchdog.stop();
      request.signal.removeEventListener('abort', onClientAbort);
    };
    const lengthHeader = Number(upstream.headers.get('content-length'));
    const captureLimit = capture?.cache
      ? registry.setting('response_cache_max_body_bytes', config.responseCacheMaxBodyBytes)
      : registry.setting('nonstream_capture_max_bytes', config.nonstreamCaptureMaxBytes);
    const canCapture = Boolean(capture) && countUsage && mode === 'json'
      && Number.isFinite(lengthHeader)
      && lengthHeader <= captureLimit;

    if (canCapture && upstream.body) {
      const reader = upstream.body.getReader();
      const extractor = createUsageExtractor({ mode, maxBytes: parseMax, startedPerf });
      const chunks = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          watchdog.touch();
          const buffer = Buffer.from(value);
          extractor.push(buffer);
          chunks.push(buffer);
        }
      } finally {
        release();
      }
      const body = Buffer.concat(chunks);
      let info = {};
      try {
        info = finishAttempt({
          extractor, requestBytes, responseBytes: body.length, counted: countUsage, route, token, model, key,
          attempt, status: upstream.status, latencyMs, now, prices, currency, fxRate, settle,
        });
      } catch (error) {
        logger.error('usage finalization failed', { routeId: route.id, error: error.message });
        abandon?.();
      }
      const headers = buildClientResponseHeaders(upstream);
      headers.set('x-smolorchestrator-provider', provider.name);
      headers.set('x-cache', 'miss');
      return {
        outcome: 'success',
        capture: {
          status: upstream.status,
          headers: [...headers],
          body,
          cost: info.estCost,
          inputTokens: info.inputTokens,
          outputTokens: info.outputTokens,
          cachedTokens: info.cachedTokens,
          downstreamCost: info.downstreamCost,
          provider: provider.name,
        },
      };
    }

    const headers = buildClientResponseHeaders(upstream);
    headers.set('x-smolorchestrator-provider', provider.name);
    let body = null;
    if (upstream.body) {
      const [clientStream, parseStream] = upstream.body.tee();
      const extractor = createUsageExtractor({ mode, maxBytes: parseMax, startedPerf });
      let responseBytes = 0;
      void (async () => {
        const reader = parseStream.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            watchdog.touch();
            responseBytes += value.length;
            extractor.push(Buffer.from(value));
          }
        } catch {
          // Aborted or upstream error; counts reflect what was observed.
        } finally {
          release();
          try {
            finishAttempt({
              extractor, requestBytes, responseBytes, counted: countUsage, route, token, model, key,
              attempt, status: upstream.status, latencyMs, now, prices, currency, fxRate, settle,
            });
          } catch (error) {
            logger.error('usage finalization failed', { routeId: route.id, error: error.message });
            abandon?.();
          }
        }
      })();
      body = clientStream;
    } else {
      release();
      try {
        finishAttempt({
          extractor: null, requestBytes, responseBytes: 0, counted: countUsage, route, token, model, key,
          attempt, status: upstream.status, latencyMs, now, prices, currency, fxRate, settle,
        });
      } catch (error) {
        logger.error('usage finalization failed', { routeId: route.id, error: error.message });
        abandon?.();
      }
    }
    return { outcome: countUsage ? 'success' : 'client_error', response: new Response(body, { status: upstream.status, headers }) };
  }

  // Records telemetry, settles rule usage, and computes upstream/downstream costs.
  function finishAttempt({
    extractor, requestBytes, responseBytes, counted, route, token, model, key, attempt, status,
    latencyMs, now, prices, currency, fxRate, settle,
  }) {
    const observed = extractor?.result() ?? null;
    const inputTokens = observed ? observed.inputTokens : estimateTokens(requestBytes);
    const outputTokens = observed ? observed.outputTokens : estimateTokens(responseBytes);
    const cachedTokens = observed?.cachedTokens ?? 0;
    const upstreamCost = observed?.upstreamCost ?? null;
    const estimated = observed === null;
    const tpsSample = observed ? {
      finishReason: observed.finishReason,
      contentTokens: observed.contentTokens,
      contentTtftMs: observed.contentTtftMs,
      contentGenerationMs: observed.contentGenerationMs,
      contentTps: observed.contentTps,
      effectiveTps: observed.effectiveTps,
      cachedTokens,
    } : null;
    const tpsValid = counted && status >= 200 && status < 400
      && isValidTpsSample(tpsSample, { maxTtftMs: model.tpsMaxTtftMs });
    if (tpsValid) {
      try {
        tps?.recordSample(route, tpsSample, Date.now());
      } catch (error) {
        logger.warn('tps sample failed', { routeId: route.id, error: error.message });
      }
    }
    const costs = resolveRouteCost(route);
    const discount = registry.setting('cached_input_discount', config.cachedInputDiscount);
    const cachedPrice = route.cachedInputCostPerM ?? costs.input * discount;
    const billableInput = Math.max(0, inputTokens - cachedTokens);
    const estCost = (billableInput * costs.input + cachedTokens * cachedPrice + outputTokens * costs.output) / 1000000;
    const savedCost = (cachedTokens * (costs.input - cachedPrice)) / 1000000;
    const downstreamCost = computeDownstreamCost(prices, { inputTokens, outputTokens, cachedTokens }) ?? 0;
    if (counted) {
      settle({ requests: 1, tokensIn: inputTokens, tokensOut: outputTokens, amount: downstreamCost }, now);
      applySuccess(route, Date.now());
      registry.markRouteDirty(route);
      metrics?.recordUsage({ model: model.name, inputTokens, outputTokens, cachedTokens, cost: estCost, savedCost });
    }
    telemetry.queue({
      type: 'event', ts: now, tokenId: token.id, modelId: model.id, routeId: route.id,
      providerKeyId: key.id, attempt, status, latencyMs,
      inputTokens, outputTokens, cachedTokens, estCost, savedCost,
      upstreamCost, downstreamCost, currency, fxRate,
      responseTokens: tpsSample?.contentTokens ?? null,
      responseTtftMs: tpsSample?.contentTtftMs ?? null,
      responseGenerationMs: tpsSample?.contentGenerationMs ?? null,
      effectiveTps: tpsValid ? tpsSample.effectiveTps : null,
      responseTps: tpsSample?.contentTps ?? null,
      bytes: responseBytes, estimated, isProbe: false,
      error: status >= 400 ? `upstream status ${status}` : null,
    });
    onRouteStateChange?.();
    return { inputTokens, outputTokens, cachedTokens, estimated, estCost, savedCost, downstreamCost };
  }

  return { passThrough };
}
