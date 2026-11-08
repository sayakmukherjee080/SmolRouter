// In-memory routing registry: authoritative hot-path state, kept in sync with SQLite.
import { decryptSecret } from '../util/crypto.js';
import { dayWindow } from './windows.js';
import { ValidationError } from './validate.js';
import { BudgetEngine } from './budgets.js';
import * as modelStore from './models.js';
import * as providerStore from './providers.js';
import * as tokenStore from './tokens.js';

export class Registry {
  constructor({ db, config, writer, logger }) {
    this.db = db;
    this.config = config;
    this.writer = writer;
    this.logger = logger;
    this.modelsByName = new Map();
    this.modelsById = new Map();
    this.routesByModel = new Map();
    this.routeById = new Map();
    this.providersById = new Map();
    this.keysByProvider = new Map();
    this.keysById = new Map();
    this.tokensByHash = new Map();
    this.tokenModelIds = new Map();
    this.settings = new Map();
    this.routeCounters = new Map();
    this.dirtyRoutes = new Map();
    this.rotationPointers = new Map();
    this.activeRequests = 0;
    this.currencyChange = false;
    this.budgets = new BudgetEngine({
      db,
      logger,
      defaults: {
        currency: () => String(this.setting('billing_currency', this.config.billingCurrency)).toUpperCase(),
        retentionDays: () => this.setting('token_usage_retention_days', this.config.tokenUsageRetentionDays),
      },
    });
  }

  // Loads the full routing image from SQLite into memory.
  load() {
    this.modelsByName.clear();
    this.modelsById.clear();
    this.routesByModel.clear();
    this.routeById.clear();
    this.providersById.clear();
    this.keysByProvider.clear();
    this.keysById.clear();
    this.tokensByHash.clear();
    this.tokenModelIds.clear();
    this.settings.clear();
    this.routeCounters.clear();

    for (const row of this.db.prepare('SELECT * FROM models WHERE deleted_at IS NULL').all()) {
      const model = {
        id: row.id,
        name: row.name,
        balanceStrategy: row.balance_strategy,
        cacheEnabled: Boolean(row.cache_enabled),
        downstreamInputCostPerM: row.downstream_input_cost_per_m,
        downstreamOutputCostPerM: row.downstream_output_cost_per_m,
        downstreamCachedInputCostPerM: row.downstream_cached_input_cost_per_m,
        downstreamCurrency: row.downstream_currency ?? 'USD',
        tpsFloor: row.tps_floor ?? null,
        preferredRouteId: row.preferred_route_id ?? null,
        tpsProbeIntervalMs: row.tps_probe_interval_ms ?? null,
        tpsMaxTtftMs: row.tps_max_ttft_ms ?? null,
      };
      this.modelsByName.set(model.name, model);
      this.modelsById.set(model.id, model);
    }
    for (const row of this.db.prepare('SELECT * FROM providers WHERE deleted_at IS NULL').all()) {
      this.providersById.set(row.id, { id: row.id, name: row.name, baseUrl: row.base_url });
      this.keysByProvider.set(row.id, []);
    }
    for (const row of this.db.prepare('SELECT * FROM provider_keys WHERE deleted_at IS NULL').all()) {
      const key = decryptSecret(row.key_enc, this.config.appSecret);
      if (!key) {
        this.logger?.error('provider key decrypt failed', { providerKeyId: row.id });
        continue;
      }
      const list = this.keysByProvider.get(row.provider_id);
      if (!list) continue;
      const entry = {
        id: row.id,
        providerId: row.provider_id,
        label: row.label,
        key,
        enabled: Boolean(row.enabled),
        disabledUntil: row.disabled_until,
      };
      list.push(entry);
      this.keysById.set(entry.id, entry);
    }
    for (const row of this.db.prepare('SELECT * FROM routes WHERE deleted_at IS NULL').all()) {
      let capabilities = null;
      if (row.capabilities) {
        try {
          capabilities = JSON.parse(row.capabilities);
        } catch {
          capabilities = null;
        }
      }
      const route = {
        id: row.id,
        modelId: row.model_id,
        providerId: row.provider_id,
        upstreamModel: row.upstream_model,
        priority: row.priority,
        inputCostPerM: row.input_cost_per_m,
        outputCostPerM: row.output_cost_per_m,
        cachedInputCostPerM: row.cached_input_cost_per_m,
        dailyQuota: row.daily_quota,
        capabilities,
        maxContext: row.max_context,
        consecutiveFailures: row.consecutive_failures,
        cooldownUntil: row.cooldown_until,
        lastProbeAt: row.last_probe_at,
        tpsResetAt: row.tps_reset_at ?? 0,
      };
      this.routeById.set(route.id, route);
      if (!this.routesByModel.has(route.modelId)) this.routesByModel.set(route.modelId, []);
      this.routesByModel.get(route.modelId).push(route);
    }
    for (const routes of this.routesByModel.values()) {
      routes.sort((a, b) => a.priority - b.priority || a.id - b.id);
    }
    for (const model of this.modelsById.values()) {
      if (model.preferredRouteId !== null && !this.routeById.has(model.preferredRouteId)) {
        model.preferredRouteId = null;
      }
    }
    for (const row of this.db.prepare('SELECT * FROM tokens WHERE deleted_at IS NULL').all()) {
      const token = {
        id: row.id,
        keyHash: row.key_hash,
        label: row.label,
        enabled: Boolean(row.enabled),
        timezone: row.timezone || 'UTC',
        createdAt: row.created_at,
        dailyRequestLimit: row.daily_request_limit,
        monthlyRequestLimit: row.monthly_request_limit,
        dailySpendLimit: row.daily_spend_limit,
        monthlySpendLimit: row.monthly_spend_limit,
      };
      this.tokensByHash.set(token.keyHash, token);
      this.tokenModelIds.set(token.id, new Set());
    }
    for (const row of this.db.prepare('SELECT token_id, model_id FROM token_models').all()) {
      this.tokenModelIds.get(row.token_id)?.add(row.model_id);
    }
    for (const row of this.db.prepare('SELECT key, value FROM settings').all()) {
      try {
        this.settings.set(row.key, JSON.parse(row.value));
      } catch {
        this.logger?.warn('setting parse failed', { key: row.key });
      }
    }
    const window = dayWindow(Date.now());
    for (const row of this.db.prepare(
      `SELECT entity_id, SUM(requests) AS requests FROM usage
       WHERE entity = ? AND window_start = ? GROUP BY entity_id`,
    ).all('route', window)) {
      this.routeCounters.set(row.entity_id, { window, count: row.requests });
    }
    this.budgets.load();
    const legacyReview = this.legacyAmountReview();
    if (legacyReview.review) {
      this.logger?.warn('legacy amount values need review', legacyReview);
    }
    this.logger?.info('registry loaded', {
      models: this.modelsById.size,
      providers: this.providersById.size,
      routes: this.routeById.size,
      tokens: this.tokensByHash.size,
    });
  }

  // Returns a setting override value, or the provided fallback.
  setting(key, fallback) {
    return this.settings.has(key) ? this.settings.get(key) : fallback;
  }

  // Returns all setting values currently stored.
  allSettings() {
    return Object.fromEntries(this.settings);
  }

  // Marks one gateway request as active for currency-change draining.
  beginRequest() {
    this.activeRequests += 1;
  }

  // Marks one gateway request as settled or abandoned.
  endRequest() {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
  }

  // Stops new gateway admissions while a billing-currency change runs.
  beginCurrencyChange() {
    if (this.currencyChange) throw new ValidationError('billing currency change already in progress');
    this.currencyChange = true;
  }

  // Re-opens gateway admissions after a currency change attempt.
  endCurrencyChange() {
    this.currencyChange = false;
  }

  // Returns legacy monetary data that predates the billing-currency feature.
  legacyAmountReview() {
    const currency = String(this.setting('billing_currency', this.config.billingCurrency)).toUpperCase();
    if (currency === 'USD') return { currency, amountRules: 0, legacyCaps: 0, legacyEvents: 0, review: false };
    const amountRules = this.db.prepare("SELECT COUNT(*) AS n FROM token_budget_rules WHERE metric = 'amount'").get().n;
    const legacyCaps = this.db.prepare(`SELECT COUNT(*) AS n FROM tokens
      WHERE daily_spend_limit IS NOT NULL OR monthly_spend_limit IS NOT NULL`).get().n;
    const legacyEvents = this.db.prepare(`SELECT COUNT(*) AS n FROM token_usage_events
      WHERE is_cache = 0 AND currency IS NULL AND downstream_cost > 0`).get().n;
    return { currency, amountRules, legacyCaps, legacyEvents, review: legacyCaps > 0 || legacyEvents > 0 };
  }

  // Rebuilds per-token rule counters from persisted usage events.
  loadTokenCounters() {
    this.budgets.load();
  }

  // Returns legacy-style budget counters derived from the active rules.
  tokenBudget(tokenId, now = Date.now()) {
    const token = this.findTokenById(tokenId);
    if (!token) return { dayRequests: 0, monthRequests: 0, daySpend: 0, monthSpend: 0 };
    return this.tokenBudgetReport(token, 1, now).usage;
  }

  // Returns the first exhausted rule reason for a token, or null.
  tokenBudgetExceeded(token, now = Date.now()) {
    return this.budgets.exceeded(token, now);
  }

  // Returns rule reports, soft warnings, and legacy-compatible counters.
  tokenBudgetReport(token, warnRatio, now = Date.now()) {
    return this.budgets.report(token, warnRatio, now);
  }

  // Compatibility helper for tests: manually count one request and optional amount.
  incrementTokenUsage(tokenId, cost = 0, now = Date.now()) {
    const token = this.findTokenById(tokenId);
    if (!token) return;
    const rules = this.budgets.rulesForToken(tokenId);
    const requestRule = rules.find((rule) => rule.metric === 'requests');
    if (requestRule) this.budgets.counterFor(requestRule, now).counter.used += 1;
    const amountRule = rules.find((rule) => rule.metric === 'amount');
    if (amountRule) this.budgets.counterFor(amountRule, now).counter.used += Math.max(0, Number(cost) || 0);
  }

  // Reserves all token rules for one admitted request.
  reserveTokenRules(token, estimates, now = Date.now()) {
    return this.budgets.reserve(token, estimates, now);
  }

  // Releases unsettled token-rule reservations.
  releaseTokenRules(handles) {
    this.budgets.release(handles);
  }

  // Reconciles token-rule reservations to actual usage.
  reconcileTokenRules(handles, actual, now = Date.now()) {
    this.budgets.reconcile(handles, actual, now);
  }

  // Returns active budget rules for a token.
  budgetRulesForToken(tokenId) {
    return this.budgets.rulesForToken(tokenId);
  }

  // Replaces all budget rules for a token.
  replaceTokenBudgetRules(tokenId, rules) {
    return this.budgets.replaceRules(tokenId, rules);
  }

  // Looks up a gateway token by its SHA-256 hash.
  tokenByHash(hash) {
    return this.tokensByHash.get(hash) || null;
  }

  // Looks up a model alias by name.
  modelByName(name) {
    return this.modelsByName.get(name) || null;
  }

  // Looks up a model by id.
  modelById(id) {
    return this.modelsById.get(id) || null;
  }

  // Returns the ordered route list for a model.
  routesForModel(modelId) {
    return this.routesByModel.get(modelId) || [];
  }

  // Looks up a route by id.
  routeByIdOrNull(id) {
    return this.routeById.get(id) || null;
  }

  // Looks up a provider by id.
  providerById(id) {
    return this.providersById.get(id) || null;
  }

  // Returns the model ids a token is scoped to.
  tokenModelIdSet(tokenId) {
    return this.tokenModelIds.get(tokenId) || new Set();
  }

  // Lists all models for admin views.
  listModels() {
    return [...this.modelsById.values()].map((model) => ({
      ...model,
      routes: this.routesForModel(model.id),
    }));
  }

  // Lists all providers with key metadata for admin views.
  listProviders() {
    return [...this.providersById.values()].map((provider) => ({
      ...provider,
      keys: (this.keysByProvider.get(provider.id) || []).map((key) => ({
        id: key.id,
        label: key.label,
        enabled: key.enabled,
        disabledUntil: key.disabledUntil,
      })),
    }));
  }

  // Lists all tokens with their scoped model ids and budget rules.
  listTokens() {
    return [...this.tokensByHash.values()].map((token) => ({
      ...token,
      modelIds: [...(this.tokenModelIds.get(token.id) || new Set())],
      budgetRules: this.budgets.rulesForToken(token.id).map((rule) => ({
        metric: rule.metric,
        period: rule.period,
        period_count: rule.period_count,
        limit_value: rule.limit_value,
        timezone: rule.timezone,
        reset_time: rule.reset_time,
        anchor: rule.anchor,
        currency: rule.currency,
        enabled: rule.enabled,
      })),
    }));
  }

  // Returns the current day's request count for a route.
  routeCount(routeId, now = Date.now()) {
    const window = dayWindow(now);
    let entry = this.routeCounters.get(routeId);
    if (!entry || entry.window !== window) {
      entry = { window, count: 0 };
      this.routeCounters.set(routeId, entry);
    }
    return entry.count;
  }

  // Increments the current day's request count for a route.
  incrementRouteCount(routeId, now = Date.now()) {
    const count = this.routeCount(routeId, now);
    this.routeCounters.set(routeId, { window: dayWindow(now), count: count + 1 });
  }

  // Reserves one unit of a route's optional daily quota.
  reserveRouteQuota(route, now = Date.now()) {
    if (!route.dailyQuota || route.dailyQuota <= 0) return { routeId: route.id, window: dayWindow(now), reserved: false };
    const count = this.routeCount(route.id, now);
    if (count >= route.dailyQuota) return null;
    this.incrementRouteCount(route.id, now);
    return { routeId: route.id, window: dayWindow(now), reserved: true };
  }

  // Releases a route quota reservation after a failed attempt.
  releaseRouteQuota(reservation) {
    if (!reservation?.reserved) return;
    const entry = this.routeCounters.get(reservation.routeId);
    if (entry && entry.window === reservation.window) entry.count = Math.max(0, entry.count - 1);
  }

  // Marks a route's volatile state for asynchronous persistence.
  markRouteDirty(route) {
    this.dirtyRoutes.set(route.id, route);
  }

  // Returns dirty route snapshots for the telemetry flush and clears them.
  takeDirtyRoutes() {
    const routes = [...this.dirtyRoutes.values()].map((route) => ({
      id: route.id,
      consecutiveFailures: route.consecutiveFailures,
      cooldownUntil: route.cooldownUntil,
      lastProbeAt: route.lastProbeAt,
    }));
    this.dirtyRoutes.clear();
    return routes;
  }

  // Re-marks routes as dirty after a failed flush so state is not lost.
  restoreDirtyRoutes(snapshots) {
    for (const snapshot of snapshots) {
      const route = this.routeById.get(snapshot.id);
      if (route) this.dirtyRoutes.set(route.id, route);
    }
  }

  // Returns and advances a rotation pointer for a given scope key.
  nextRotationIndex(scope, size) {
    if (size <= 0) return 0;
    const current = this.rotationPointers.get(scope) ?? 0;
    this.rotationPointers.set(scope, (current + 1) % size);
    return current % size;
  }

  // Selects the next healthy key for a provider using round-robin.
  nextProviderKey(providerId, now = Date.now()) {
    const keys = (this.keysByProvider.get(providerId) || [])
      .filter((key) => key.enabled && key.disabledUntil <= now);
    if (keys.length === 0) return null;
    return keys[this.nextRotationIndex(`provider:${providerId}`, keys.length)];
  }

  // Returns a usable provider key without advancing rotation, or null.
  peekProviderKey(providerId, now = Date.now()) {
    const keys = (this.keysByProvider.get(providerId) || [])
      .filter((key) => key.enabled && key.disabledUntil <= now);
    return keys[0] || null;
  }

  // Looks up a provider key by id in constant time.
  keyById(keyId) {
    return this.keysById.get(Number(keyId)) || null;
  }

  // Queues an audit row through the async writer.
  queueAudit(entry) {
    this.writer?.queue({ type: 'audit', ...entry });
  }

  // Persists and caches a runtime setting.
  setSetting(key, value) {
    const name = String(key ?? '').trim();
    if (!name) throw new ValidationError('setting key is required');
    if (name === 'billing_currency') {
      throw new ValidationError('billing_currency must be changed through the admin settings API');
    }
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(name, JSON.stringify(value));
    this.settings.set(name, value);
    return value;
  }

  // Returns rows for the telemetry API with pagination.
  telemetryPage({ limit = 100, offset = 0 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    return this.db.prepare(
      'SELECT * FROM telemetry ORDER BY id DESC LIMIT ? OFFSET ?',
    ).all(safeLimit, safeOffset);
  }

  // Aggregates usage rows for a window, optionally filtered by entity type.
  usageReport({ entity = null, windowStart = null } = {}) {
    const clauses = [];
    const params = [];
    if (entity) { clauses.push('entity = ?'); params.push(entity); }
    if (windowStart !== null) { clauses.push('window_start = ?'); params.push(Number(windowStart)); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(
      `SELECT entity, entity_id, window_start, requests, tokens_in, tokens_out, cached_tokens, cost, saved_cost,
              upstream_cost, downstream_cost, currency, fx_rate
       FROM usage ${where} ORDER BY window_start DESC, cost DESC LIMIT 1000`,
    ).all(...params);
  }

  // ---- Model and route mutations (delegated to store/models.js) ----

  createModel(input) { return modelStore.createModel(this, input); }
  updateModel(id, patch) { return modelStore.updateModel(this, id, patch); }
  softDeleteModel(id) { return modelStore.softDeleteModel(this, id); }
  requireModel(id) { return modelStore.requireModel(this, id); }
  createRoute(input) { return modelStore.createRoute(this, input); }
  updateRoute(routeId, patch) { return modelStore.updateRoute(this, routeId, patch); }
  softDeleteRoute(routeId) { return modelStore.softDeleteRoute(this, routeId); }

  // ---- Provider mutations (delegated to store/providers.js) ----

  createProvider(input) { return providerStore.createProvider(this, input); }
  updateProvider(id, patch) { return providerStore.updateProvider(this, id, patch); }
  softDeleteProvider(id) { return providerStore.softDeleteProvider(this, id); }
  requireProvider(id) { return providerStore.requireProvider(this, id); }
  addProviderKey(providerId, input) { return providerStore.addProviderKey(this, providerId, input); }
  updateProviderKey(providerKeyId, patch) { return providerStore.updateProviderKey(this, providerKeyId, patch); }
  softDeleteProviderKey(providerKeyId) { return providerStore.softDeleteProviderKey(this, providerKeyId); }
  findProviderKey(providerKeyId) { return providerStore.findProviderKey(this, providerKeyId); }

  // ---- Token mutations (delegated to store/tokens.js) ----

  createToken(input) { return tokenStore.createToken(this, input); }
  updateToken(tokenId, patch) { return tokenStore.updateToken(this, tokenId, patch); }
  softDeleteToken(tokenId) { return tokenStore.softDeleteToken(this, tokenId); }
  setTokenModels(tokenId, modelIds) { return tokenStore.setTokenModels(this, tokenId, modelIds); }
  findTokenById(tokenId) { return tokenStore.findTokenById(this, tokenId); }
  importToken(input) { return tokenStore.importToken(this, input); }
}
