// Admin JSON API: CRUD for models, providers, keys, routes, tokens, settings, usage.
import { parseJsonBody, readBodyCapped, envelopeSuccess, envelopeError } from '../util/body.js';
import { clientIp } from '../util/headers.js';
import { hashPassword, verifyPassword } from '../util/crypto.js';
import { ValidationError } from '../store/validate.js';
import { dayWindow } from '../store/windows.js';
import { exportBundle, importBundle } from '../store/configBundle.js';
import { resolveRouteCost } from '../gateway/pricing.js';
import { createSettingsService } from './settings.js';

// Returns the requested percentile from a sorted numeric array.
function percentile(sorted, quantile) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))];
}

// Reads and parses a JSON request body with the configured size cap.
async function readJson(request, config, registry) {
  const raw = await readBodyCapped(request.body, registry.setting('max_body_bytes', config.maxBodyBytes));
  const parsed = parseJsonBody(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const error = new Error('Request body must be a JSON object');
    error.code = 'BAD_JSON';
    throw error;
  }
  return parsed;
}

export function createAdminApi({ registry, session, config, logger, backups, gateway, fx, telemetry }) {
  const settingsService = createSettingsService({ registry, config, logger, fx, telemetry });
  const settingsView = settingsService.view;
  const tps = gateway.tps;

  // Computes p50/p95 latency per model and provider from recent successful attempts.
  function latencyReport(hours = 24) {
    const since = Date.now() - hours * 3600000;
    const rows = registry.db.prepare(`SELECT route_id, latency_ms FROM telemetry
      WHERE ts >= ? AND is_probe = 0 AND status >= 200 AND status < 400
      ORDER BY ts DESC LIMIT 5000`).all(since);
    const groups = new Map();
    for (const row of rows) {
      const route = registry.routeByIdOrNull(row.route_id);
      const model = route ? registry.modelById(route.modelId) : null;
      const provider = route ? registry.providerById(route.providerId) : null;
      const key = `${model?.name ?? 'unknown'}::${provider?.name ?? 'unknown'}`;
      if (!groups.has(key)) {
        groups.set(key, { model: model?.name ?? 'unknown', provider: provider?.name ?? 'unknown', latencies: [] });
      }
      groups.get(key).latencies.push(row.latency_ms);
    }
    return [...groups.values()].map(({ model, provider, latencies }) => {
      latencies.sort((a, b) => a - b);
      return {
        model, provider, requests: latencies.length,
        p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95),
      };
    }).sort((a, b) => b.requests - a.requests);
  }

  // Computes median effective TPS and TTFT per model and provider from recent valid samples.
  function tpsReport(hours = 24) {
    const since = Date.now() - hours * 3600000;
    const rows = registry.db.prepare(`SELECT route_id, response_tokens, effective_tps, response_ttft_ms,
        response_tps, ts
      FROM telemetry
      WHERE ts >= ? AND is_probe = 0 AND status >= 200 AND status < 400
        AND effective_tps IS NOT NULL AND cached_tokens = 0
      ORDER BY ts DESC LIMIT 5000`).all(since);
    const groups = new Map();
    for (const row of rows) {
      const route = registry.routeByIdOrNull(row.route_id);
      const model = route ? registry.modelById(route.modelId) : null;
      const provider = route ? registry.providerById(route.providerId) : null;
      const key = `${route?.id ?? 0}`;
      if (!groups.has(key)) {
        groups.set(key, {
          model: model?.name ?? 'unknown',
          provider: provider?.name ?? 'unknown',
          routeId: route?.id ?? null,
          upstreamModel: route?.upstreamModel ?? null,
          effective: [],
          ttft: [],
          content: [],
          tokens: 0,
          lastAt: 0,
        });
      }
      const group = groups.get(key);
      group.effective.push(row.effective_tps);
      if (Number.isFinite(row.response_ttft_ms)) group.ttft.push(row.response_ttft_ms);
      if (Number.isFinite(row.response_tps)) group.content.push(row.response_tps);
      group.tokens += row.response_tokens ?? 0;
      group.lastAt = Math.max(group.lastAt, row.ts);
    }
    const median = (values) => {
      if (values.length === 0) return null;
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor((sorted.length - 1) / 2)];
    };
    return [...groups.values()].map((group) => ({
      model: group.model,
      provider: group.provider,
      routeId: group.routeId,
      upstreamModel: group.upstreamModel,
      samples: group.effective.length,
      effectiveTps: median(group.effective),
      ttftMs: median(group.ttft),
      contentTps: median(group.content),
      responseTokens: group.tokens,
      lastAt: group.lastAt || null,
    })).sort((a, b) => b.samples - a.samples);
  }

  // Returns response-cache aggregates for the current UTC day.
  function cacheReport() {
    return registry.db.prepare('SELECT * FROM cache_stats WHERE window_start >= ? ORDER BY saved_cost DESC')
      .all(dayWindow(Date.now()))
      .map((row) => ({ ...row, model: registry.modelById(row.model_id)?.name ?? null }));
  }

  // Runs a mutation, mapping validation failures to 422 and queuing an audit row.
  function mutate(request, audit, fn) {
    return Promise.resolve()
      .then(fn)
      .then((data) => {
        registry.queueAudit({ action: audit.action, resourceType: audit.resourceType, resourceId: audit.resourceId?.(data), actor: audit.actor, ip: audit.ip, outcome: 'success' });
        return envelopeSuccess(data, audit.status ?? 200);
      })
      .catch((error) => {
        registry.queueAudit({ action: audit.action, resourceType: audit.resourceType, resourceId: audit.resourceId?.(), actor: audit.actor, ip: audit.ip, outcome: 'failure', details: { error: error.message } });
        if (error instanceof ValidationError) return envelopeError(error.message, 'validation_error', 422);
        if (error.code === 'BAD_JSON') return envelopeError('Malformed JSON body', 'invalid_json', 400);
        if (error.code === 'PAYLOAD_TOO_LARGE') {
          const response = envelopeError('Request body too large', 'payload_too_large', 413);
          response.headers.set('connection', 'close');
          return response;
        }
        throw error;
      });
  }

  // Fetches the upstream model list for a provider using a pooled key.
  async function upstreamModels(providerId) {
    const provider = registry.providerById(providerId);
    if (!provider) throw new ValidationError('provider not found');
    const key = registry.peekProviderKey(provider.id);
    if (!key) throw new ValidationError('provider has no usable key');
    const response = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { authorization: `Bearer ${key.key}`, 'user-agent': 'smolorchestrator/2.0' },
      signal: AbortSignal.timeout(config.idleTimeoutMs),
    });
    if (!response.ok) throw new ValidationError(`upstream returned ${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > registry.setting('max_body_bytes', config.maxBodyBytes)) {
      throw new ValidationError('upstream response too large');
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ValidationError('upstream returned invalid JSON');
    }
    const data = Array.isArray(parsed?.data) ? parsed.data : [];
    return data.filter((item) => item && typeof item.id === 'string').slice(0, 2000).map((item) => ({ id: item.id }));
  }

  // Returns the model ids that currently route through a provider.
  function modelsForProvider(providerId) {
    const affected = new Set();
    for (const [modelId, routes] of registry.routesByModel) {
      if (routes.some((route) => route.providerId === providerId)) affected.add(modelId);
    }
    return affected;
  }

  // Returns the routes that currently use a provider.
  function routesForProvider(providerId) {
    const routes = [];
    for (const list of registry.routesByModel.values()) {
      for (const route of list) {
        if (route.providerId === providerId) routes.push(route);
      }
    }
    return routes;
  }

  // Invalidates cached responses for every model using a provider.
  function invalidateProviderModels(providerId) {
    for (const modelId of modelsForProvider(providerId)) gateway.responseCache.invalidateModel(modelId);
  }

  // Dispatches admin API requests under /api/v1.
  async function handle(request, url) {
    const path = url.pathname.replace(/^\/api\/v1/, '') || '/';
    const method = request.method.toUpperCase();

    if (path === '/session' && method === 'POST') {
      let body;
      try {
        body = await readJson(request, config, registry);
      } catch (error) {
        if (error.code === 'BAD_JSON') return envelopeError('Malformed JSON body', 'invalid_json', 400);
        if (error.code === 'PAYLOAD_TOO_LARGE') {
          const response = envelopeError('Request body too large', 'payload_too_large', 413);
          response.headers.set('connection', 'close');
          return response;
        }
        throw error;
      }
      const ip = clientIp(request, config.trustProxy);
      const result = session.login(body.email, body.password, ip);
      if (!result.ok) return envelopeError(result.message, 'invalid_credentials', result.status);
      return Response.json({ success: true, data: { email: result.email, csrf: result.csrf } }, {
        status: 200,
        headers: { 'set-cookie': result.cookie },
      });
    }

    const auth = session.requireSession(request);
    if (auth.error) return auth.error;
    const csrfError = session.requireCsrf(request, auth.session);
    if (csrfError) return csrfError;
    const actor = auth.session.email;
    const requestIp = clientIp(request, config.trustProxy);

    if (path === '/session' && method === 'GET') {
      return envelopeSuccess({ email: actor, csrf: auth.session.csrf });
    }
    if (path === '/session' && method === 'DELETE') {
      registry.queueAudit({ action: 'logout', actor, ip: requestIp, outcome: 'success' });
      return new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'set-cookie': session.clearingCookie() },
      });
    }
    if (path === '/session/password' && method === 'PUT') {
      let body;
      try {
        body = await readJson(request, config, registry);
      } catch (error) {
        if (error.code === 'BAD_JSON') return envelopeError('Malformed JSON body', 'invalid_json', 400);
        if (error.code === 'PAYLOAD_TOO_LARGE') return envelopeError('Request body too large', 'payload_too_large', 413);
        throw error;
      }
      const row = registry.db.prepare('SELECT id, password_hash FROM admin ORDER BY id LIMIT 1').get();
      if (!row || typeof body.currentPassword !== 'string' || !verifyPassword(body.currentPassword, row.password_hash)) {
        registry.queueAudit({ action: 'password.change', actor, ip: requestIp, outcome: 'failure', details: { reason: 'invalid_current' } });
        return envelopeError('Current password is incorrect', 'invalid_credentials', 401);
      }
      const minLength = Number(process.env.MIN_PASSWORD_LENGTH || 10);
      if (typeof body.newPassword !== 'string' || body.newPassword.length < minLength) {
        return envelopeError(`New password must be at least ${minLength} characters`, 'validation_error', 422);
      }
      registry.db.prepare('UPDATE admin SET password_hash = ?, password_changed_at = ? WHERE id = ?')
        .run(hashPassword(body.newPassword), Date.now(), row.id);
      registry.queueAudit({ action: 'password.change', actor, ip: requestIp, outcome: 'success' });
      return envelopeSuccess({ changed: true });
    }

    if (path === '/models' && method === 'GET') {
      const models = registry.listModels().map((model) => ({
        ...model,
        tps: tps?.status(model) ?? null,
        routes: model.routes.map((route) => {
          const costs = resolveRouteCost(route);
          return {
            ...route,
            resolvedInputCostPerM: costs.input,
            resolvedOutputCostPerM: costs.output,
            pricingSource: costs.source,
          };
        }),
      }));
      return envelopeSuccess({ models });
    }
    if (path === '/model-info' && method === 'GET') {
      const currency = String(registry.setting('billing_currency', config.billingCurrency)).toUpperCase();
      const models = registry.listModels().map((model) => ({
        model_name: model.name,
        downstream: {
          input_cost_per_million: model.downstreamInputCostPerM,
          output_cost_per_million: model.downstreamOutputCostPerM,
          cached_input_cost_per_million: model.downstreamCachedInputCostPerM,
          currency: model.downstreamCurrency ?? currency,
        },
        routes: model.routes.map((route) => {
          const costs = resolveRouteCost(route);
          return {
            id: route.id,
            upstream_model: route.upstreamModel,
            input_cost_per_million: route.inputCostPerM,
            output_cost_per_million: route.outputCostPerM,
            resolved_input_cost_per_million: costs.input,
            resolved_output_cost_per_million: costs.output,
            pricing_source: costs.source,
          };
        }),
      }));
      return envelopeSuccess({ models, currency });
    }
    if (path === '/models' && method === 'POST') {
      return mutate(request, { action: 'model.create', resourceType: 'model', actor, ip: requestIp, status: 201 },
        async () => {
          const model = registry.createModel(await readJson(request, config, registry));
          tps?.syncModel(model);
          return model;
        });
    }
    let match = /^\/models\/(\d+)$/.exec(path);
    if (match && method === 'PATCH') {
      return mutate(request, { action: 'model.update', resourceType: 'model', resourceId: () => Number(match[1]), actor, ip: requestIp },
        async () => {
          const patch = await readJson(request, config, registry);
          const model = registry.updateModel(Number(match[1]), patch);
          gateway.responseCache.invalidateModel(model.id);
          if ('tpsFloor' in patch || 'preferredRouteId' in patch || 'tpsProbeIntervalMs' in patch
            || 'tpsMaxTtftMs' in patch) {
            tps?.syncModel(model);
          }
          return model;
        });
    }
    if (match && method === 'DELETE') {
      return mutate(request, { action: 'model.delete', resourceType: 'model', resourceId: () => Number(match[1]), actor, ip: requestIp },
        async () => {
          const id = Number(match[1]);
          registry.softDeleteModel(id);
          gateway.responseCache.invalidateModel(id);
          gateway.pins.clearModel(id);
          tps?.invalidateModel(id);
          return { id };
        });
    }

    match = /^\/models\/(\d+)\/routes$/.exec(path);
    if (match && method === 'GET') return envelopeSuccess({ routes: registry.routesForModel(Number(match[1])) });
    if (match && method === 'POST') {
      const modelId = Number(match[1]);
      return mutate(request, { action: 'route.create', resourceType: 'route', actor, ip: requestIp, status: 201 },
        async () => {
          const route = registry.createRoute({ ...(await readJson(request, config, registry)), modelId });
          gateway.responseCache.invalidateModel(route.modelId);
          return route;
        });
    }

    match = /^\/models\/(\d+)\/tps\/probe$/.exec(path);
    if (match && method === 'POST') {
      const modelId = Number(match[1]);
      return mutate(request, { action: 'model.tps.probe', resourceType: 'model', resourceId: () => modelId, actor, ip: requestIp },
        async () => {
          const model = registry.requireModel(modelId);
          if (!tps) return { probed: false, reason: 'tps_unavailable', tps: null };
          const current = tps.status(model);
          if (!current.enabled) return { probed: false, reason: 'tps_disabled', tps: current };
          const route = tps.preferredRoute(model);
          const passed = await tps.probeNow(route.id);
          return { probed: true, passed, tps: tps.status(model) };
        });
    }

    if (path === '/providers' && method === 'GET') return envelopeSuccess({ providers: registry.listProviders() });
    if (path === '/providers' && method === 'POST') {
      return mutate(request, { action: 'provider.create', resourceType: 'provider', actor, ip: requestIp, status: 201 },
        async () => registry.createProvider(await readJson(request, config, registry)));
    }
    match = /^\/providers\/(\d+)$/.exec(path);
    if (match && method === 'PATCH') {
      return mutate(request, { action: 'provider.update', resourceType: 'provider', resourceId: () => Number(match[1]), actor, ip: requestIp },
        async () => {
          const id = Number(match[1]);
          const before = registry.providerById(id);
          const previousBaseUrl = before?.baseUrl;
          const provider = registry.updateProvider(id, await readJson(request, config, registry));
          invalidateProviderModels(id);
          if (previousBaseUrl === undefined || previousBaseUrl !== provider.baseUrl) {
            for (const route of routesForProvider(id)) tps?.invalidateRoute(route.id);
          }
          return provider;
        });
    }
    if (match && method === 'DELETE') {
      return mutate(request, { action: 'provider.delete', resourceType: 'provider', resourceId: () => Number(match[1]), actor, ip: requestIp },
        async () => {
          const id = Number(match[1]);
          const affected = modelsForProvider(id);
          registry.softDeleteProvider(id);
          for (const modelId of affected) {
            gateway.responseCache.invalidateModel(modelId);
            gateway.pins.clearModel(modelId);
            tps?.invalidateModel(modelId);
          }
          return { id };
        });
    }
    match = /^\/providers\/(\d+)\/upstream-models$/.exec(path);
    if (match && method === 'GET') {
      return mutate(request, { action: 'provider.upstream_models', resourceType: 'provider', resourceId: () => Number(match[1]), actor, ip: requestIp },
        async () => ({ models: await upstreamModels(Number(match[1])) }));
    }
    match = /^\/providers\/(\d+)\/keys$/.exec(path);
    if (match && method === 'POST') {
      const providerId = Number(match[1]);
      return mutate(request, { action: 'provider_key.create', resourceType: 'provider_key', actor, ip: requestIp, status: 201 },
        async () => registry.addProviderKey(providerId, await readJson(request, config, registry)));
    }

    match = /^\/keys\/(\d+)$/.exec(path);
    if (match && method === 'PATCH') {
      return mutate(request, { action: 'provider_key.update', resourceType: 'provider_key', resourceId: () => Number(match[1]), actor, ip: requestIp },
        async () => registry.updateProviderKey(Number(match[1]), await readJson(request, config, registry)));
    }
    if (match && method === 'DELETE') {
      return mutate(request, { action: 'provider_key.delete', resourceType: 'provider_key', resourceId: () => Number(match[1]), actor, ip: requestIp },
        async () => { registry.softDeleteProviderKey(Number(match[1])); return { id: Number(match[1]) }; });
    }

    match = /^\/routes\/(\d+)$/.exec(path);
    if (match && method === 'PATCH') {
      return mutate(request, { action: 'route.update', resourceType: 'route', resourceId: () => Number(match[1]), actor, ip: requestIp },
        async () => {
          const id = Number(match[1]);
          const before = registry.routeByIdOrNull(id);
          const beforeProviderId = before?.providerId;
          const beforeUpstream = before?.upstreamModel;
          const route = registry.updateRoute(id, await readJson(request, config, registry));
          gateway.responseCache.invalidateModel(route.modelId);
          if (beforeProviderId === undefined || beforeProviderId !== route.providerId || beforeUpstream !== route.upstreamModel) {
            tps?.invalidateRoute(route.id);
          }
          return route;
        });
    }
    if (match && method === 'DELETE') {
      return mutate(request, { action: 'route.delete', resourceType: 'route', resourceId: () => Number(match[1]), actor, ip: requestIp },
        async () => {
          const id = Number(match[1]);
          const existing = registry.routeByIdOrNull(id);
          registry.softDeleteRoute(id);
          if (existing) {
            gateway.responseCache.invalidateModel(existing.modelId);
            gateway.pins.clearRoute(id);
            tps?.invalidateRoute(id);
          }
          return { id };
        });
    }

    if (path === '/tokens' && method === 'GET') {
      const ratio = registry.setting('budget_warn_ratio', config.budgetWarnRatio);
      const tokens = registry.listTokens().map((token) => {
        const report = registry.tokenBudgetReport(token, ratio);
        return {
          ...token, budgetUsage: report.usage, budgetWarnings: report.warnings,
          budgetRemaining: report.remaining, budgetRules: report.rules,
        };
      });
      return envelopeSuccess({ tokens });
    }
    match = /^\/tokens\/(\d+)$/.exec(path);
    if (match && method === 'GET') {
      const token = registry.findTokenById(Number(match[1]));
      if (!token) return envelopeError('token not found', 'not_found', 404);
      const ratio = registry.setting('budget_warn_ratio', config.budgetWarnRatio);
      const report = registry.tokenBudgetReport(token, ratio);
      return envelopeSuccess({ token: { ...token, budgetUsage: report.usage, budgetRules: report.rules } });
    }
    if (path === '/tokens' && method === 'POST') {
      return mutate(request, { action: 'token.create', resourceType: 'token', actor, ip: requestIp, status: 201 },
        async () => {
          const body = await readJson(request, config, registry);
          const { token, raw } = registry.createToken(body);
          return { ...token, raw };
        });
    }
    match = /^\/tokens\/(\d+)$/.exec(path);
    if (match && method === 'PATCH') {
      return mutate(request, { action: 'token.update', resourceType: 'token', resourceId: () => Number(match[1]), actor, ip: requestIp },
        async () => registry.updateToken(Number(match[1]), await readJson(request, config, registry)));
    }
    if (match && method === 'DELETE') {
      return mutate(request, { action: 'token.delete', resourceType: 'token', resourceId: () => Number(match[1]), actor, ip: requestIp },
        async () => {
          const id = Number(match[1]);
          registry.softDeleteToken(id);
          gateway.pins.clearToken(id);
          return { id };
        });
    }
    match = /^\/tokens\/(\d+)\/models$/.exec(path);
    if (match && method === 'PUT') {
      const tokenId = Number(match[1]);
      return mutate(request, { action: 'token.scope', resourceType: 'token', resourceId: () => tokenId, actor, ip: requestIp },
        async () => ({ modelIds: registry.setTokenModels(tokenId, (await readJson(request, config, registry)).modelIds) }));
    }

    if (path === '/usage' && method === 'GET') {
      const clauses = ["entity = 'model'"];
      const params = [];
      if (url.searchParams.get('windowStart')) {
        clauses.push('window_start = ?');
        params.push(Number(url.searchParams.get('windowStart')));
      }
      const currencySummary = registry.db.prepare(`SELECT currency,
          COALESCE(SUM(requests), 0) AS requests,
          COALESCE(SUM(tokens_in), 0) AS tokens_in,
          COALESCE(SUM(tokens_out), 0) AS tokens_out,
          COALESCE(SUM(cost), 0) AS cost,
          COALESCE(SUM(upstream_cost), 0) AS upstream_cost,
          COALESCE(SUM(downstream_cost), 0) AS downstream_cost,
          CASE WHEN SUM(CASE WHEN currency <> 'USD' AND (fx_rate IS NULL OR fx_rate <= 0) THEN 1 ELSE 0 END) > 0 THEN NULL
            ELSE COALESCE(SUM(downstream_cost - COALESCE(upstream_cost, cost) * COALESCE(fx_rate, 1)), 0)
          END AS margin
        FROM usage WHERE ${clauses.join(' AND ')} GROUP BY currency ORDER BY currency`).all(...params);
      return envelopeSuccess({
        usage: registry.usageReport({
          entity: url.searchParams.get('entity'),
          windowStart: url.searchParams.get('windowStart'),
        }),
        currencySummary,
        cacheStats: cacheReport(),
        latency: latencyReport(),
        tps: tpsReport(),
      });
    }
    if (path === '/telemetry' && method === 'GET') {
      return envelopeSuccess({ telemetry: registry.telemetryPage({
        limit: url.searchParams.get('limit'),
        offset: url.searchParams.get('offset'),
      }) });
    }
    if (path === '/settings' && method === 'GET') {
      return envelopeSuccess({ settings: settingsView(), cacheEntries: gateway.responseCache.size });
    }
    if (path === '/settings' && method === 'PUT') {
      return mutate(request, { action: 'settings.update', resourceType: 'settings', actor, ip: requestIp },
        async () => {
          await settingsService.update(await readJson(request, config, registry));
          return { settings: settingsView(), cacheEntries: gateway.responseCache.size };
        });
    }
    if (path === '/cache/flush' && method === 'POST') {
      return mutate(request, { action: 'cache.flush', resourceType: 'cache', actor, ip: requestIp },
        async () => {
          const cleared = gateway.responseCache.size;
          gateway.responseCache.clear();
          return { cleared };
        });
    }

    if (path === '/backups' && method === 'GET') {
      return envelopeSuccess({
        backups: backups.list(),
        enabled: config.backupEnabled,
        intervalMs: config.backupIntervalMs,
        keep: config.backupKeep,
      });
    }
    if (path === '/backups' && method === 'POST') {
      return mutate(request, { action: 'backup.create', resourceType: 'backup', actor, ip: requestIp, status: 201 },
        async () => ({ backup: backups.createNow() }));
    }

    if (path === '/config/export' && method === 'GET') {
      const includeSecrets = url.searchParams.get('secrets') === '1';
      return envelopeSuccess({
        bundle: exportBundle(registry, { includeSecrets }),
        warning: includeSecrets ? 'Provider keys are encrypted with this instance secret; they only import where APP_SECRET matches.' : undefined,
      });
    }
    if (path === '/config/import' && method === 'POST') {
      return mutate(request, { action: 'config.import', resourceType: 'config', actor, ip: requestIp },
        async () => {
          const body = await readJson(request, config, registry);
          const result = importBundle(registry, body.bundle ?? body);
          tps?.reload();
          return result;
        });
    }

    logger.warn('admin api not found', { path, method });
    return envelopeError('Not found', 'not_found', 404);
  }

  return { handle };
}
