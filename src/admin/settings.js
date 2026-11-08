// Admin settings validation, persistence, and atomic billing-currency conversion.
import { ValidationError } from '../store/validate.js';

const SETTING_KEYS = new Set([
  'backoff_base_ms', 'backoff_cap_ms', 'probe_enabled', 'probe_budget_per_hour',
  'health_check_enabled', 'health_check_interval_ms',
  'response_cache_enabled', 'response_cache_ttl_ms', 'response_cache_max_entries',
  'response_cache_max_body_bytes', 'response_cache_max_total_bytes',
  'cached_input_discount', 'budget_warn_ratio',
  'telemetry_retention_days', 'usage_retention_days', 'token_usage_retention_days',
  'max_attempts', 'idle_timeout_ms', 'key_disable_ms', 'key_retries_per_route',
  'probe_prompt', 'probe_max_tokens', 'max_body_bytes', 'usage_parse_max_bytes',
  'nonstream_capture_max_bytes',
  'trust_proxy', 'cookie_secure', 'ip_rate_limit', 'ip_rate_window_ms',
  'login_max_attempts', 'login_lockout_ms', 'session_ttl_ms', 'metrics_token',
  'telemetry_buffer_max', 'telemetry_flush_ms', 'backup_interval_ms', 'backup_keep',
  'maintenance_interval_ms', 'billing_currency', 'fx_cache_ttl_ms', 'fx_max_stale_ms',
]);
const BOOLEAN_SETTINGS = new Set([
  'probe_enabled', 'health_check_enabled', 'response_cache_enabled', 'trust_proxy', 'cookie_secure',
]);
const STRING_SETTINGS = new Map([
  ['probe_prompt', { max: 200, allowEmpty: false }],
  ['metrics_token', { max: 256, allowEmpty: true }],
  ['billing_currency', { max: 3, allowEmpty: false }],
]);
const MINIMUM_SETTINGS = new Map([
  ['health_check_interval_ms', 10000],
  ['response_cache_ttl_ms', 1000],
  ['response_cache_max_entries', 1],
  ['response_cache_max_body_bytes', 1024],
  ['response_cache_max_total_bytes', 1024],
  ['max_attempts', 1],
  ['idle_timeout_ms', 1000],
  ['key_disable_ms', 1000],
  ['key_retries_per_route', 1],
  ['probe_max_tokens', 1],
  ['max_body_bytes', 1024],
  ['usage_parse_max_bytes', 1024],
  ['nonstream_capture_max_bytes', 1024],
  ['ip_rate_limit', 1],
  ['ip_rate_window_ms', 1000],
  ['login_max_attempts', 1],
  ['login_lockout_ms', 1000],
  ['session_ttl_ms', 60000],
  ['telemetry_buffer_max', 100],
  ['telemetry_flush_ms', 50],
  ['backup_interval_ms', 3600000],
  ['backup_keep', 1],
  ['maintenance_interval_ms', 3600000],
  ['usage_retention_days', 32],
  ['token_usage_retention_days', 32],
  ['fx_cache_ttl_ms', 60000],
  ['fx_max_stale_ms', 60000],
]);
const RATIO_SETTINGS = new Set(['cached_input_discount', 'budget_warn_ratio']);

// Builds the settings view merged from config defaults and stored overrides.
function settingsView({ registry, config }) {
  return {
    backoff_base_ms: registry.setting('backoff_base_ms', config.backoffBaseMs),
    backoff_cap_ms: registry.setting('backoff_cap_ms', config.backoffCapMs),
    probe_enabled: registry.setting('probe_enabled', config.probeEnabled),
    probe_budget_per_hour: registry.setting('probe_budget_per_hour', config.probeBudgetPerHour),
    health_check_enabled: registry.setting('health_check_enabled', config.healthCheckEnabled),
    health_check_interval_ms: registry.setting('health_check_interval_ms', config.healthCheckIntervalMs),
    response_cache_enabled: registry.setting('response_cache_enabled', config.responseCacheEnabled),
    response_cache_ttl_ms: registry.setting('response_cache_ttl_ms', config.responseCacheTtlMs),
    response_cache_max_entries: registry.setting('response_cache_max_entries', config.responseCacheMaxEntries),
    response_cache_max_body_bytes: registry.setting('response_cache_max_body_bytes', config.responseCacheMaxBodyBytes),
    response_cache_max_total_bytes: registry.setting('response_cache_max_total_bytes', config.responseCacheMaxTotalBytes),
    cached_input_discount: registry.setting('cached_input_discount', config.cachedInputDiscount),
    budget_warn_ratio: registry.setting('budget_warn_ratio', config.budgetWarnRatio),
    telemetry_retention_days: registry.setting('telemetry_retention_days', config.telemetryRetentionDays),
    usage_retention_days: registry.setting('usage_retention_days', config.usageRetentionDays),
    token_usage_retention_days: registry.setting('token_usage_retention_days', config.tokenUsageRetentionDays),
    max_attempts: registry.setting('max_attempts', config.maxAttempts),
    idle_timeout_ms: registry.setting('idle_timeout_ms', config.idleTimeoutMs),
    key_disable_ms: registry.setting('key_disable_ms', config.keyDisableMs),
    key_retries_per_route: registry.setting('key_retries_per_route', config.keyRetriesPerRoute),
    probe_prompt: registry.setting('probe_prompt', config.probePrompt),
    probe_max_tokens: registry.setting('probe_max_tokens', config.probeMaxTokens),
    max_body_bytes: registry.setting('max_body_bytes', config.maxBodyBytes),
    usage_parse_max_bytes: registry.setting('usage_parse_max_bytes', config.usageParseMaxBytes),
    nonstream_capture_max_bytes: registry.setting('nonstream_capture_max_bytes', config.nonstreamCaptureMaxBytes),
    trust_proxy: registry.setting('trust_proxy', config.trustProxy),
    cookie_secure: registry.setting('cookie_secure', config.cookieSecure),
    ip_rate_limit: registry.setting('ip_rate_limit', config.ipRateLimit),
    ip_rate_window_ms: registry.setting('ip_rate_window_ms', config.ipRateWindowMs),
    login_max_attempts: registry.setting('login_max_attempts', config.loginMaxAttempts),
    login_lockout_ms: registry.setting('login_lockout_ms', config.loginLockoutMs),
    session_ttl_ms: registry.setting('session_ttl_ms', config.sessionTtlMs),
    metrics_token: registry.setting('metrics_token', config.metricsToken),
    telemetry_buffer_max: registry.setting('telemetry_buffer_max', config.telemetryBufferMax),
    telemetry_flush_ms: registry.setting('telemetry_flush_ms', config.telemetryFlushMs),
    backup_interval_ms: registry.setting('backup_interval_ms', config.backupIntervalMs),
    backup_keep: registry.setting('backup_keep', config.backupKeep),
    maintenance_interval_ms: registry.setting('maintenance_interval_ms', config.maintenanceIntervalMs),
    billing_currency: registry.setting('billing_currency', config.billingCurrency),
    fx_cache_ttl_ms: registry.setting('fx_cache_ttl_ms', config.fxCacheTtlMs),
    fx_max_stale_ms: registry.setting('fx_max_stale_ms', config.fxMaxStaleMs),
    legacy_amount_review: registry.legacyAmountReview(),
  };
}

// Creates the settings service bound to the registry, config, logger, FX cache, and telemetry writer.
export function createSettingsService({ registry, config, logger, fx, telemetry }) {
  // Returns the active billing currency.
  function currentCurrency() {
    return String(registry.setting('billing_currency', config.billingCurrency)).toUpperCase();
  }

  // Returns true when stored monetary values make a currency change ambiguous.
  function monetaryDataExists() {
    const models = registry.db.prepare(`SELECT COUNT(*) AS n FROM models
      WHERE downstream_input_cost_per_m IS NOT NULL
         OR downstream_output_cost_per_m IS NOT NULL
         OR downstream_cached_input_cost_per_m IS NOT NULL`).get().n;
    if (models > 0) return true;
    const rules = registry.db.prepare("SELECT COUNT(*) AS n FROM token_budget_rules WHERE metric = 'amount'").get().n;
    if (rules > 0) return true;
    const usage = registry.db.prepare('SELECT COUNT(*) AS n FROM usage WHERE cost > 0 OR downstream_cost > 0').get().n;
    return usage > 0;
  }

  // Computes converted model prices, amount-rule limits, and legacy spend caps.
  async function currencyConversion(from, to) {
    const fromRate = from === 'USD' ? 1 : await fx.rate(from);
    const toRate = to === 'USD' ? 1 : await fx.rate(to);
    if (!Number.isFinite(fromRate) || fromRate <= 0 || !Number.isFinite(toRate) || toRate <= 0) {
      throw new ValidationError('currency conversion unavailable; FX rate could not be resolved');
    }
    const factor = toRate / fromRate;
    const models = registry.db.prepare(`SELECT id, downstream_input_cost_per_m, downstream_output_cost_per_m,
      downstream_cached_input_cost_per_m FROM models`).all().map((row) => {
      const convert = (value) => (value === null ? null : value * factor);
      const input = convert(row.downstream_input_cost_per_m);
      const output = convert(row.downstream_output_cost_per_m);
      const cached = convert(row.downstream_cached_input_cost_per_m);
      for (const value of [input, output, cached]) {
        if (value !== null && (!Number.isFinite(value) || value < 0)) {
          throw new ValidationError('currency conversion produced an invalid model price');
        }
      }
      return { id: row.id, input, output, cached };
    });
    const rules = registry.db.prepare("SELECT id, limit_value FROM token_budget_rules WHERE metric = 'amount'").all()
      .map((row) => {
        const limit = row.limit_value * factor;
        if (!Number.isFinite(limit) || limit <= 0) {
          throw new ValidationError('currency conversion produced an invalid budget limit');
        }
        return { id: row.id, limit };
      });
    const tokens = registry.db.prepare('SELECT id, daily_spend_limit, monthly_spend_limit FROM tokens').all()
      .map((row) => {
        const daily = row.daily_spend_limit === null ? null : row.daily_spend_limit * factor;
        const monthly = row.monthly_spend_limit === null ? null : row.monthly_spend_limit * factor;
        for (const value of [daily, monthly]) {
          if (value !== null && (!Number.isFinite(value) || value < 0)) {
            throw new ValidationError('currency conversion produced an invalid token spend limit');
          }
        }
        return { id: row.id, daily, monthly };
      });
    return { factor, models, rules, tokens };
  }

  // Waits for active gateway requests to drain before a currency change.
  async function waitForIdleRequests() {
    const timeoutMs = config.currencyChangeDrainMs ?? 30000;
    const deadline = Date.now() + timeoutMs;
    while (registry.activeRequests > 0) {
      if (Date.now() >= deadline) {
        throw new ValidationError('billing currency change requires no in-flight gateway requests; retry when idle');
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  // Validates and persists runtime settings, converting monetary data atomically on request.
  async function update(body) {
    const payload = body && typeof body === 'object' ? body : {};
    const convertCurrency = payload.convertCurrency === true;
    const pending = [];
    let nextCurrency = null;
    for (const [key, value] of Object.entries(payload)) {
      if (key === 'convertCurrency') continue;
      if (!SETTING_KEYS.has(key)) throw new ValidationError(`unknown setting ${key}`);
      if (BOOLEAN_SETTINGS.has(key)) {
        if (typeof value !== 'boolean') throw new ValidationError(`${key} must be boolean`);
        pending.push([key, value]);
        continue;
      }
      const stringRule = STRING_SETTINGS.get(key);
      if (stringRule) {
        if (typeof value !== 'string') throw new ValidationError(`${key} must be a string`);
        const trimmed = value.trim();
        if (!stringRule.allowEmpty && !trimmed) throw new ValidationError(`${key} must not be empty`);
        if (trimmed.length > stringRule.max) throw new ValidationError(`${key} is too long`);
        if (key === 'billing_currency' && !/^[A-Za-z]{3}$/.test(trimmed)) {
          throw new ValidationError('billing_currency must be a 3-letter ISO code');
        }
        const normalized = key === 'billing_currency' ? trimmed.toUpperCase() : trimmed;
        pending.push([key, normalized]);
        if (key === 'billing_currency') nextCurrency = normalized;
        continue;
      }
      const num = Number(value);
      if (!Number.isFinite(num) || num < 0) throw new ValidationError(`${key} must be a non-negative number`);
      if (RATIO_SETTINGS.has(key) && num > 1) throw new ValidationError(`${key} must be between 0 and 1`);
      if (key === 'max_attempts' && num > 64) throw new ValidationError('max_attempts must be at most 64');
      const minimum = MINIMUM_SETTINGS.get(key);
      if (minimum !== undefined && num < minimum) throw new ValidationError(`${key} must be at least ${minimum}`);
      pending.push([key, RATIO_SETTINGS.has(key) ? num : Math.trunc(num)]);
    }

    const previousCurrency = currentCurrency();
    const currencyChange = Boolean(nextCurrency && nextCurrency !== previousCurrency);
    if (currencyChange && registry.currencyChange) {
      throw new ValidationError('billing currency change already in progress');
    }
    const monetary = currencyChange ? monetaryDataExists() : false;
    if (currencyChange && monetary && !convertCurrency) {
      throw new ValidationError('billing_currency change requires convertCurrency=true because monetary data exists');
    }
    let conversion = null;

    // Applies converted monetary data and settings in one transaction.
    function persist() {
      registry.db.exec('BEGIN IMMEDIATE');
      try {
        if (conversion) {
          const updateModel = registry.db.prepare(`UPDATE models SET downstream_input_cost_per_m = ?,
            downstream_output_cost_per_m = ?, downstream_cached_input_cost_per_m = ?, downstream_currency = ?
            WHERE id = ?`);
          for (const model of conversion.models) {
            updateModel.run(model.input, model.output, model.cached, nextCurrency, model.id);
          }
          const updateRule = registry.db.prepare('UPDATE token_budget_rules SET limit_value = ?, currency = ? WHERE id = ?');
          for (const rule of conversion.rules) updateRule.run(rule.limit, nextCurrency, rule.id);
          const updateToken = registry.db.prepare('UPDATE tokens SET daily_spend_limit = ?, monthly_spend_limit = ? WHERE id = ?');
          for (const token of conversion.tokens) updateToken.run(token.daily, token.monthly, token.id);
          // Current budget windows rebuild from these events; convert them so
          // historical spend stays accounted after the limit currency changes.
          registry.db.prepare(`UPDATE token_usage_events
            SET downstream_cost = downstream_cost * ?, currency = ?
            WHERE currency IS NULL OR currency = ?`).run(conversion.factor, nextCurrency, previousCurrency);
        }
        const write = registry.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
        for (const [key, value] of pending) write.run(key, JSON.stringify(value));
        registry.db.exec('COMMIT');
      } catch (error) {
        registry.db.exec('ROLLBACK');
        throw error;
      }

      for (const [key, value] of pending) registry.settings.set(key, value);
      if (conversion) {
        for (const model of conversion.models) {
          const entry = registry.modelsById.get(model.id);
          if (!entry) continue;
          entry.downstreamInputCostPerM = model.input;
          entry.downstreamOutputCostPerM = model.output;
          entry.downstreamCachedInputCostPerM = model.cached;
          entry.downstreamCurrency = nextCurrency;
        }
        for (const token of conversion.tokens) {
          const entry = registry.findTokenById(token.id);
          if (!entry) continue;
          entry.dailySpendLimit = token.daily;
          entry.monthlySpendLimit = token.monthly;
        }
        registry.budgets.load();
        registry.queueAudit({
          action: 'settings.currency.convert',
          resourceType: 'settings',
          outcome: 'success',
          details: { from: previousCurrency, to: nextCurrency, rate: conversion.factor },
        });
        logger.info('billing currency converted', { from: previousCurrency, to: nextCurrency, rate: conversion.factor });
      }
    }

    if (currencyChange) {
      registry.beginCurrencyChange();
      try {
        await waitForIdleRequests();
        await telemetry?.flush();
        if (telemetry?.hasPendingBilling?.()) {
          throw new ValidationError('billing telemetry flush failed; retry the currency change');
        }
        const monetaryAfterDrain = monetaryDataExists();
        if (monetaryAfterDrain && !convertCurrency) {
          throw new ValidationError('billing_currency change requires convertCurrency=true because monetary data exists');
        }
        if (monetaryAfterDrain) conversion = await currencyConversion(previousCurrency, nextCurrency);
        persist();
      } finally {
        registry.endCurrencyChange();
      }
    } else {
      persist();
    }
    return settingsView({ registry, config });
  }

  return { view: () => settingsView({ registry, config }), update };
}
