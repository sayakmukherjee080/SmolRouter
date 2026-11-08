// Transparent OpenAI-compatible proxy: routing, reservations, billing, caching, telemetry.
import { readBodyCapped, parseJsonBody, openAiError } from '../util/body.js';
import { buildUpstreamRequestHeaders, clientIp } from '../util/headers.js';
import { authenticate, canAccessModel } from './auth.js';
import { IpRateLimiter } from './ratelimit.js';
import { pickRoute } from './balance.js';
import { pickKey, disableKey } from './pools.js';
import { applyFailure } from './cooldown.js';
import { PinStore, resolvePin, assignPin } from './pins.js';
import { listModelsForToken } from './models.js';
import { buildUpstreamUrl } from './upstream_url.js';
import { createIdleWatchdog, retryAfterMs } from './http_util.js';
import { applyBudgetHeaders, applyCostHeaders } from './billing_headers.js';
import { createInfo } from './info.js';
import { createProbeRunner } from './probe_runner.js';
import { createResponseHandler } from './response.js';
import {
  resolveDownstreamPrices, computeDownstreamCost,
  maxDownstreamEstimate, hasDownstreamPrices,
} from './pricing.js';
import { buildRequirements, hasCompatibleRoute, InputError } from './requirements.js';
import { requestCacheKey, ResponseCache, SingleFlight } from './cache.js';

const FAILOVER_STATUSES = new Set([404, 408, 409, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
const AUTH_STATUSES = new Set([401, 403]);

// Creates the gateway facade with proxy, model listing, pricing, and probe entry points.
export function createGateway({ registry, config, telemetry, logger, metrics, fx, onRouteStateChange }) {
  const limiter = new IpRateLimiter({ limit: config.ipRateLimit, windowMs: config.ipRateWindowMs });
  const pins = new PinStore();
  const responseCache = new ResponseCache({
    maxEntries: () => registry.setting('response_cache_max_entries', config.responseCacheMaxEntries),
    maxBodyBytes: () => registry.setting('response_cache_max_body_bytes', config.responseCacheMaxBodyBytes),
    maxTotalBytes: () => registry.setting('response_cache_max_total_bytes', config.responseCacheMaxTotalBytes),
  });
  const singleFlight = new SingleFlight();
  const info = createInfo({ registry, config, fx });
  const responseHandler = createResponseHandler({ registry, config, telemetry, logger, metrics, onRouteStateChange });
  const { runProbe } = createProbeRunner({ registry, config, telemetry, metrics, fx });

  // Returns whether the exact response cache may serve this model.
  function cacheEnabledFor(model) {
    if (!config.responseCacheEnabled) return false;
    if (registry.setting('response_cache_enabled', true) === false) return false;
    return Boolean(model.cacheEnabled);
  }

  // Resolves downstream prices for a cache hit, where no upstream cost is incurred.
  function cachePrices(model, fxRate, currency) {
    return resolveDownstreamPrices(model, { inputCostPerM: 0, outputCostPerM: 0, upstreamModel: '' }, fxRate, currency);
  }

  // Builds a client response from a cached entry.
  function cacheResponse(entry, budgetReport, modelName, downstreamCost) {
    const headers = new Headers(entry.headers);
    headers.set('x-cache', 'hit');
    applyCostHeaders(headers, downstreamCost);
    applyBudgetHeaders(headers, budgetReport, modelName);
    return new Response(entry.body, { status: entry.status, headers });
  }

  // Builds a client response from a captured upstream body.
  function captureResponse(capture, budgetReport, modelName, downstreamCost, cacheStatus = 'miss') {
    const headers = new Headers(capture.headers);
    headers.set('x-cache', cacheStatus);
    applyCostHeaders(headers, downstreamCost);
    applyBudgetHeaders(headers, budgetReport, modelName);
    return new Response(capture.body, { status: capture.status, headers });
  }

  // Finalises a streaming attempt result with client headers.
  function finishResult(result, budgetReport, modelName, cacheStatus = 'miss') {
    if (!result || !result.response) return result?.response;
    if (!result.response.headers.has('x-cache')) result.response.headers.set('x-cache', cacheStatus);
    applyBudgetHeaders(result.response.headers, budgetReport, modelName);
    return result.response;
  }

  // Handles GET /v1/models for the authenticated token scope.
  async function handleModels(request) {
    const auth = authenticate(request, registry);
    if (auth.error) return auth.error;
    return Response.json(listModelsForToken(registry, auth.token));
  }

  // Tracks one gateway request and blocks admissions during a currency change.
  async function handleProxy(request, subPath) {
    registry.beginRequest();
    let handedOff = false;
    try {
      return await handleProxyRequest(request, subPath, () => { handedOff = true; });
    } finally {
      if (!handedOff) registry.endRequest();
    }
  }

  // Handles POST /v1/chat/completions and generic JSON paths.
  async function handleProxyRequest(request, subPath, onReserved) {
    if (registry.currencyChange) {
      return openAiError('Billing currency change in progress', 'currency_change_in_progress', 503, 'api_error');
    }
    const ip = clientIp(request, registry.setting('trust_proxy', config.trustProxy));
    const rateLimit = registry.setting('ip_rate_limit', config.ipRateLimit);
    const rateWindow = registry.setting('ip_rate_window_ms', config.ipRateWindowMs);
    if (!limiter.allow(ip, Date.now(), rateLimit, rateWindow)) {
      return openAiError('Rate limit exceeded', 'rate_limit_exceeded', 429, 'rate_limit_error');
    }
    const auth = authenticate(request, registry);
    if (auth.error) return auth.error;
    const token = auth.token;
    const warnRatio = registry.setting('budget_warn_ratio', config.budgetWarnRatio);
    const preReport = registry.tokenBudgetReport(token, warnRatio);
    const preReason = registry.tokenBudgetExceeded(token);
    if (preReason) {
      metrics?.recordBudgetRejection();
      const response = openAiError(`Token budget exceeded (${preReason})`, 'budget_exceeded', 429, 'insufficient_quota');
      applyBudgetHeaders(response.headers, preReport);
      return response;
    }

    let rawBody;
    try {
      rawBody = await readBodyCapped(request.body, registry.setting('max_body_bytes', config.maxBodyBytes));
    } catch (error) {
      if (error.code === 'PAYLOAD_TOO_LARGE') {
        const response = openAiError('Request body too large', 'payload_too_large', 413);
        response.headers.set('connection', 'close');
        return response;
      }
      if (request.signal.aborted) return openAiError('Client closed request', 'client_closed_request', 499);
      throw error;
    }

    let payload;
    try {
      payload = parseJsonBody(rawBody);
    } catch {
      return openAiError('Malformed JSON body', 'invalid_json', 400);
    }
    const requestedModel = typeof payload.model === 'string' ? payload.model : null;
    if (!requestedModel) return openAiError("Missing required field 'model'", 'invalid_request_error', 400);

    const model = registry.modelByName(requestedModel);
    if (!model || !canAccessModel(registry, token, model.id)) {
      return openAiError(`The model '${requestedModel}' does not exist`, 'model_not_found', 404);
    }

    let requirements;
    try {
      requirements = buildRequirements(payload, rawBody.length);
    } catch (error) {
      if (error instanceof InputError) return openAiError(error.message, 'invalid_request_error', 400);
      throw error;
    }
    if (requirements.capabilities.size > 0 && !hasCompatibleRoute(registry, model, requirements)) {
      return openAiError(
        `No route supports required capabilities: ${[...requirements.capabilities].join(', ')}`,
        'unsupported_feature', 400,
      );
    }

    const streaming = payload.stream === true;
    if (streaming) {
      const options = (payload.stream_options && typeof payload.stream_options === 'object')
        ? payload.stream_options : {};
      if (!options.include_usage) payload.stream_options = { ...options, include_usage: true };
    }

    const currency = String(registry.setting('billing_currency', config.billingCurrency)).toUpperCase();
    if (hasDownstreamPrices(model) && String(model.downstreamCurrency || 'USD').toUpperCase() !== currency) {
      return openAiError(
        `Model pricing currency ${model.downstreamCurrency} does not match billing currency ${currency}`,
        'currency_mismatch', 409,
      );
    }
    const fxRate = await fx.rate(currency);
    const usageEstimate = {
      inputTokens: requirements.estimatedInputTokens,
      outputTokens: requirements.maxOutputTokens,
    };
    const routes = registry.routesForModel(model.id);
    const estimatedAmount = maxDownstreamEstimate(model, routes, fxRate, usageEstimate, currency);
    const hasAmountRules = registry.budgetRulesForToken(token.id).some((rule) => rule.metric === 'amount');
    if (hasAmountRules && estimatedAmount === null) {
      return openAiError('Currency conversion unavailable for amount budgets', 'fx_unavailable', 503, 'api_error');
    }
    const reservation = registry.reserveTokenRules(token, {
      tokensIn: usageEstimate.inputTokens,
      tokensOut: usageEstimate.outputTokens,
      amount: estimatedAmount ?? 0,
    });
    if (!reservation.ok) {
      metrics?.recordBudgetRejection();
      const response = openAiError(`Token budget exceeded (${reservation.reason})`, 'budget_exceeded', 429, 'insufficient_quota');
      applyBudgetHeaders(response.headers, registry.tokenBudgetReport(token, warnRatio));
      return response;
    }
    const handles = reservation.handles;
    onReserved();
    const settlement = { settled: false };
    // Reconciles reserved rule counters with actual usage exactly once.
    const settle = (actual, when = Date.now()) => {
      if (settlement.settled) return;
      try {
        registry.reconcileTokenRules(handles, actual, when);
      } catch (error) {
        logger.error('token rule reconcile failed', { tokenId: token.id, error: error.message });
        registry.releaseTokenRules(handles);
      } finally {
        settlement.settled = true;
        registry.endRequest();
      }
    };
    // Releases unused reservations exactly once.
    const abandon = () => {
      if (settlement.settled) return;
      settlement.settled = true;
      try {
        registry.releaseTokenRules(handles);
      } finally {
        registry.endRequest();
      }
    };

    const runAttempts = (capture) => attemptLoop({
      request, token, model, payload, subPath, requirements, capture, fxRate, currency, settle, abandon,
    });

    const cacheEligible = cacheEnabledFor(model) && !streaming && payload.temperature === 0;
    const cacheKey = cacheEligible ? requestCacheKey(model.id, payload) : null;
    const budgetRatio = () => registry.setting('budget_warn_ratio', config.budgetWarnRatio);
    try {
      if (cacheKey) {
        const hit = responseCache.get(cacheKey);
        if (hit) {
          const downstreamCost = computeDownstreamCost(cachePrices(model, fxRate, currency), {
            inputTokens: hit.inputTokens ?? 0,
            outputTokens: hit.outputTokens ?? 0,
            cachedTokens: hit.cachedTokens ?? 0,
          }) ?? 0;
          settle({ requests: 1, tokensIn: hit.inputTokens ?? 0, tokensOut: hit.outputTokens ?? 0, amount: downstreamCost });
          metrics?.recordCache({ model: model.name, outcome: 'hit', savedCost: hit.cost });
          telemetry.queue({
            type: 'cache', ts: Date.now(), tokenId: token.id, modelId: model.id, outcome: 'hit',
            savedCost: hit.cost, savedTokensIn: hit.inputTokens ?? 0, savedTokensOut: hit.outputTokens ?? 0,
            inputTokens: hit.inputTokens ?? 0, outputTokens: hit.outputTokens ?? 0,
            downstreamCost, currency, fxRate,
          });
          return cacheResponse(hit, registry.tokenBudgetReport(token, budgetRatio()), model.name, downstreamCost);
        }
        const { shared, result } = await singleFlight.run(cacheKey, () => runAttempts({ cache: true }));
        if (result.capture) {
          const capture = result.capture;
          if (!shared) {
            responseCache.set(cacheKey, {
              ...capture,
              modelId: model.id,
              expiresAt: Date.now() + registry.setting('response_cache_ttl_ms', config.responseCacheTtlMs),
            });
          } else {
            settle({
              requests: 1,
              tokensIn: capture.inputTokens ?? 0,
              tokensOut: capture.outputTokens ?? 0,
              amount: capture.downstreamCost ?? 0,
            });
          }
          metrics?.recordCache({ model: model.name, outcome: shared ? 'coalesced' : 'miss', savedCost: shared ? capture.cost : 0 });
          telemetry.queue({
            type: 'cache', ts: Date.now(), tokenId: token.id, modelId: model.id,
            outcome: shared ? 'coalesced' : 'miss',
            savedCost: shared ? capture.cost : 0,
            savedTokensIn: shared ? capture.inputTokens : 0,
            savedTokensOut: shared ? capture.outputTokens : 0,
            inputTokens: shared ? capture.inputTokens : 0,
            outputTokens: shared ? capture.outputTokens : 0,
            downstreamCost: shared ? (capture.downstreamCost ?? 0) : 0,
            currency, fxRate,
          });
          return captureResponse(
            capture,
            registry.tokenBudgetReport(token, budgetRatio()),
            model.name,
            capture.downstreamCost,
            shared ? 'coalesced' : 'miss',
          );
        }
        if (shared) {
          metrics?.recordCache({ model: model.name, outcome: 'miss' });
          telemetry.queue({ type: 'cache', ts: Date.now(), tokenId: token.id, modelId: model.id, outcome: 'miss' });
          return finishResult(await runAttempts({ cache: false }), registry.tokenBudgetReport(token, budgetRatio()), model.name, 'miss');
        }
        return finishResult(result, registry.tokenBudgetReport(token, budgetRatio()), model.name, 'miss');
      }

      const result = await runAttempts({ cache: false });
      if (result.capture) {
        return captureResponse(
          result.capture,
          registry.tokenBudgetReport(token, budgetRatio()),
          model.name,
          result.capture.downstreamCost,
          'bypass',
        );
      }
      return finishResult(result, registry.tokenBudgetReport(token, budgetRatio()), model.name, 'bypass');
    } catch (error) {
      abandon();
      throw error;
    }
  }

  // Runs the route selection and failover loop for one client request.
  async function attemptLoop({
    request, token, model, payload, subPath, requirements, capture, fxRate, currency, settle, abandon,
  }) {
    const excluded = new Set();
    const keyFailures = new Map();
    const errors = [];
    const cacheAware = model.balanceStrategy === 'cache_aware';
    const maxAttempts = registry.setting('max_attempts', config.maxAttempts);
    const keyRetries = registry.setting('key_retries_per_route', config.keyRetriesPerRoute);
    let attempt = 0;
    // Returns true when every remaining route is blocked by its daily quota.
    const quotaBlocked = () => {
      const routes = registry.routesForModel(model.id);
      return routes.length > 0 && routes.every((route) =>
        Boolean(route.dailyQuota && registry.routeCount(route.id, Date.now()) >= route.dailyQuota));
    };
    // Builds the quota-exhausted client response.
    const quotaError = () => openAiError('All routes have exhausted their quota', 'quota_exhausted', 429, 'rate_limit_error');
    while (attempt < maxAttempts) {
      const now = Date.now();
      let route;
      let key;
      if (cacheAware) {
        const pair = resolvePin({ registry, model, token, pins, now, requirements })
          ?? assignPin({ registry, model, pins, excluded, now, requirements });
        if (!pair) {
          if (quotaBlocked()) {
            abandon();
            return { response: quotaError() };
          }
          break;
        }
        route = pair.route;
        key = pair.key;
        pins.set(token.id, model.id, route.id, key.id);
      } else {
        route = pickRoute({ registry, model, excluded, now, requirements });
        if (!route) {
          if (quotaBlocked()) {
            abandon();
            return { response: quotaError() };
          }
          break;
        }
        key = pickKey(registry, route.providerId, now);
        if (!key) {
          excluded.add(route.id);
          continue;
        }
      }
      const quota = registry.reserveRouteQuota(route, now);
      if (!quota) {
        excluded.add(route.id);
        continue;
      }
      attempt += 1;
      const provider = registry.providerById(route.providerId);
      const prices = resolveDownstreamPrices(model, route, fxRate, currency);
      let result;
      const started = Date.now();
      try {
        result = await attemptRoute({
          request, route, provider, key, payload, subPath, token, model, attempt, capture,
          fxRate, currency, prices, settle, abandon,
        });
      } catch (error) {
        if (request.signal.aborted) {
          metrics?.recordAttempt({ model: model.name, provider: provider.name, outcome: 'client_closed' });
          registry.releaseRouteQuota(quota);
          abandon();
          return { response: openAiError('Client closed request', 'client_closed_request', 499) };
        }
        logger.warn('attempt threw', { routeId: route.id, error: error.message });
        result = { outcome: 'failure', status: 0, error: error.message, latencyMs: 0 };
      }
      if (result.outcome === 'client_closed') {
        metrics?.recordAttempt({ model: model.name, provider: provider.name, outcome: 'client_closed' });
        registry.releaseRouteQuota(quota);
        abandon();
        telemetry.queue({
          type: 'event', ts: Date.now(), tokenId: token.id, modelId: model.id,
          routeId: route.id, providerKeyId: key.id, attempt, status: 499,
          latencyMs: result.latencyMs ?? Date.now() - started, error: 'client_closed', isProbe: false,
          currency, fxRate,
        });
        return { response: openAiError('Client closed request', 'client_closed_request', 499) };
      }
      if (result.outcome === 'success' || result.outcome === 'client_error') {
        metrics?.recordAttempt({ model: model.name, provider: provider.name, outcome: result.outcome });
        if (result.outcome === 'client_error') registry.releaseRouteQuota(quota);
        if (result.outcome === 'client_error') abandon();
        if (result.capture) return { capture: result.capture };
        return { response: result.response };
      }
      errors.push(result.error);
      metrics?.recordAttempt({ model: model.name, provider: provider.name, outcome: 'failure' });
      registry.releaseRouteQuota(quota);
      if (cacheAware) pins.delete(token.id, model.id);
      if (result.keyFailed) {
        const failures = (keyFailures.get(route.id) || 0) + 1;
        keyFailures.set(route.id, failures);
        if (failures >= keyRetries) excluded.add(route.id);
      } else {
        const delay = applyFailure(route, {
          now: Date.now(),
          baseMs: registry.setting('backoff_base_ms', config.backoffBaseMs),
          capMs: registry.setting('backoff_cap_ms', config.backoffCapMs),
          retryAfterMs: result.retryAfterMs ?? 0,
        });
        registry.markRouteDirty(route);
        logger.warn('route failed', { routeId: route.id, error: result.error, backoffMs: delay });
      }
      telemetry.queue({
        type: 'event', ts: Date.now(), tokenId: token.id, modelId: model.id,
        routeId: route.id, providerKeyId: key.id, attempt, status: result.status ?? 0,
        latencyMs: result.latencyMs ?? 0, error: result.error, isProbe: false,
        currency, fxRate,
      });
      onRouteStateChange?.();
    }
    abandon();
    logger.error('all routes failed', { model: model.name, errors });
    return { response: openAiError('All upstream providers failed', 'all_providers_failed', 502, 'api_error') };
  }

  // Executes one upstream attempt and maps the outcome for the retry loop.
  async function attemptRoute({
    request, route, provider, key, payload, subPath, token, model, attempt, capture,
    fxRate, currency, prices, settle, abandon,
  }) {
    const outboundBody = Buffer.from(JSON.stringify({ ...payload, model: route.upstreamModel }));
    const controller = new AbortController();
    const onClientAbort = () => controller.abort(new Error('client_aborted'));
    if (request.signal.aborted) onClientAbort();
    else request.signal.addEventListener('abort', onClientAbort, { once: true });
    const watchdog = createIdleWatchdog(registry.setting('idle_timeout_ms', config.idleTimeoutMs), () => controller.abort(new Error('upstream_idle_timeout')));
    watchdog.touch();
    const started = Date.now();
    let upstream;
    try {
      upstream = await fetch(buildUpstreamUrl(provider.baseUrl, subPath), {
        method: 'POST',
        headers: buildUpstreamRequestHeaders(request, key.key),
        body: outboundBody,
        signal: controller.signal,
      });
    } catch (error) {
      watchdog.stop();
      request.signal.removeEventListener('abort', onClientAbort);
      if (request.signal.aborted) return { outcome: 'client_closed', latencyMs: Date.now() - started };
      return { outcome: 'failure', error: error.message, latencyMs: Date.now() - started };
    }

    const latencyMs = Date.now() - started;
    if (AUTH_STATUSES.has(upstream.status)) {
      watchdog.stop();
      request.signal.removeEventListener('abort', onClientAbort);
      disableKey(key, Date.now(), registry.setting('key_disable_ms', config.keyDisableMs));
      await upstream.body?.cancel().catch(() => {});
      return { outcome: 'failure', keyFailed: true, status: upstream.status, error: `upstream auth error ${upstream.status}`, latencyMs };
    }
    if (FAILOVER_STATUSES.has(upstream.status)) {
      watchdog.stop();
      request.signal.removeEventListener('abort', onClientAbort);
      await upstream.body?.cancel().catch(() => {});
      return {
        outcome: 'failure', status: upstream.status, error: `upstream status ${upstream.status}`,
        latencyMs, retryAfterMs: retryAfterMs(upstream),
      };
    }
    const countUsage = upstream.status < 400;
    return responseHandler.passThrough({
      request, upstream, route, provider, key, token, model, attempt, latencyMs,
      watchdog, onClientAbort, countUsage, capture, fxRate, currency, prices, settle, abandon,
    });
  }

  return {
    handleModels, handleProxy, runProbe, limiter, pins, responseCache,
    modelInfo: info.modelInfo, keyInfo: info.keyInfo,
  };
}
