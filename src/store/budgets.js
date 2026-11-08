// Unified per-token budget rules: timezone windows, exact reservations, reports.
import { ruleWindow, periodLabel } from './windows.js';
import { ValidationError } from './validate.js';

const METRICS = new Set(['requests', 'tokens_in', 'tokens_out', 'tokens_total', 'amount']);
const PERIODS = new Set(['hour', 'n_hours', 'day', 'n_days', 'week', 'month']);

// Validates a currency code and returns it in uppercase.
function requireCurrency(value, field = 'currency') {
  const currency = String(value || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new ValidationError(`${field} must be a 3-letter ISO code`);
  return currency;
}

// Returns an upper bound for a rule window length in days.
function windowDays(period, periodCount) {
  if (period === 'hour') return 1;
  if (period === 'n_hours') return Math.ceil(periodCount / 24);
  if (period === 'day') return 1;
  if (period === 'n_days') return periodCount;
  if (period === 'week') return 7;
  return 31;
}

// Validates and normalizes a budget rule payload before any database write.
export function normalizeRule(rule, { currency = null, retentionDays = null } = {}) {
  if (!rule || typeof rule !== 'object') throw new ValidationError('budget rule must be an object');
  const metric = String(rule.metric || '');
  if (!METRICS.has(metric)) throw new ValidationError(`unknown budget metric: ${metric}`);
  const period = String(rule.period || '');
  if (!PERIODS.has(period)) throw new ValidationError(`unknown budget period: ${period}`);
  const periodCount = period === 'n_hours' || period === 'n_days' ? Number(rule.period_count ?? rule.periodCount ?? 1) : 1;
  if (!Number.isInteger(periodCount) || periodCount < 1 || periodCount > 1000) {
    throw new ValidationError('period_count must be an integer between 1 and 1000');
  }
  const days = windowDays(period, periodCount);
  const retention = retentionDays === null ? null : Number(retentionDays);
  if (retention !== null && Number.isFinite(retention) && retention > 0 && days > retention) {
    throw new ValidationError(`budget window of ${days} days exceeds token_usage_retention_days (${retention})`);
  }
  const limit = Number(rule.limit_value ?? rule.limit);
  if (!Number.isFinite(limit) || limit <= 0) throw new ValidationError('budget limit must be a positive number');
  const timezone = String(rule.timezone || 'UTC');
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
  } catch {
    throw new ValidationError(`invalid timezone: ${timezone}`);
  }
  const resetTime = Number(rule.reset_time ?? rule.resetTime ?? 0);
  if (!Number.isInteger(resetTime) || resetTime < 0 || resetTime > 1439) {
    throw new ValidationError('reset_time must be minutes since local midnight (0-1439)');
  }
  let anchor = rule.anchor ?? null;
  if (period === 'n_days') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(anchor || ''));
    if (!match) throw new ValidationError('n_days rules require anchor YYYY-MM-DD');
    const [year, month, day] = match.slice(1).map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
      throw new ValidationError('n_days anchor must be a real calendar date');
    }
    anchor = String(anchor);
  } else if (period === 'n_hours') {
    anchor = Number(anchor ?? 0);
    if (!Number.isInteger(anchor) || anchor < 0 || anchor > 23) throw new ValidationError('n_hours anchor must be 0-23');
    anchor = String(anchor);
  } else if (period === 'week') {
    anchor = Number(anchor ?? 1);
    if (!Number.isInteger(anchor) || anchor < 0 || anchor > 6) throw new ValidationError('week anchor must be 0-6');
  } else if (period === 'month') {
    anchor = Number(anchor ?? 1);
    if (!Number.isInteger(anchor) || anchor < 1 || anchor > 31) throw new ValidationError('month anchor must be 1-31');
  } else {
    anchor = null;
  }
  const billingCurrency = currency === null ? null : requireCurrency(currency, 'billing_currency');
  const ruleCurrency = metric === 'amount' ? requireCurrency(rule.currency ?? billingCurrency ?? 'USD', 'rule currency') : null;
  if (billingCurrency !== null && ruleCurrency !== null && ruleCurrency !== billingCurrency) {
    throw new ValidationError(`amount rule currency ${ruleCurrency} does not match billing currency ${billingCurrency}`);
  }
  return {
    metric,
    period,
    period_count: periodCount,
    limit_value: limit,
    timezone,
    reset_time: resetTime,
    anchor: anchor === null ? null : String(anchor),
    currency: ruleCurrency,
    enabled: rule.enabled === undefined ? true : Boolean(rule.enabled),
  };
}

// Normalizes and validates a complete rule list before any database write.
export function normalizeRules(rules, options = {}) {
  if (!Array.isArray(rules)) throw new ValidationError('budget rules must be an array');
  return rules.map((rule) => normalizeRule(rule, options));
}

// Returns a stable identity for a rule shape, used to follow in-flight reservations.
function ruleKey(rule) {
  const anchor = rule.anchor === null || rule.anchor === undefined || rule.anchor === ''
    ? (rule.period === 'n_hours' ? '0' : '')
    : String(rule.anchor);
  return [rule.metric, rule.period, rule.period_count, rule.timezone, rule.reset_time, anchor, rule.currency ?? ''].join('|');
}

// Returns a legacy-style reason label for known daily/monthly rules.
function reasonLabel(rule) {
  if (rule.metric === 'requests' && rule.period === 'day') return 'daily_requests';
  if (rule.metric === 'requests' && rule.period === 'month') return 'monthly_requests';
  if (rule.metric === 'amount' && rule.period === 'day') return 'daily_spend';
  if (rule.metric === 'amount' && rule.period === 'month') return 'monthly_spend';
  return `${rule.metric}_${periodLabel(rule)}`;
}

// Returns the estimate for one metric from a request estimate bundle.
function estimateFor(rule, estimates) {
  if (rule.metric === 'requests') return 1;
  if (rule.metric === 'tokens_in') return Math.max(0, Number(estimates.tokensIn) || 0);
  if (rule.metric === 'tokens_out') return Math.max(0, Number(estimates.tokensOut) || 0);
  if (rule.metric === 'tokens_total') return Math.max(0, (Number(estimates.tokensIn) || 0) + (Number(estimates.tokensOut) || 0));
  return Math.max(0, Number(estimates.amount) || 0);
}

// Returns the actual value for one metric from a settled usage bundle.
function actualFor(rule, actual) {
  if (rule.metric === 'requests') return Number(actual.requests ?? 1);
  if (rule.metric === 'tokens_in') return Math.max(0, Number(actual.tokensIn) || 0);
  if (rule.metric === 'tokens_out') return Math.max(0, Number(actual.tokensOut) || 0);
  if (rule.metric === 'tokens_total') return Math.max(0, (Number(actual.tokensIn) || 0) + (Number(actual.tokensOut) || 0));
  return Math.max(0, Number(actual.amount) || 0);
}

// Maps a stored row to the in-memory rule shape.
function ruleFromRow(row) {
  return {
    id: row.id,
    tokenId: row.token_id,
    metric: row.metric,
    period: row.period,
    period_count: row.period_count,
    limit_value: row.limit_value,
    timezone: row.timezone,
    reset_time: row.reset_time,
    anchor: row.anchor,
    currency: row.currency ?? null,
    enabled: Boolean(row.enabled),
  };
}

export class BudgetEngine {
  constructor({ db, logger, defaults = {} }) {
    this.db = db;
    this.logger = logger;
    this.defaults = defaults;
    this.rulesByToken = new Map();
    this.counters = new Map();
  }

  // Returns validation defaults from live settings for rule normalization.
  ruleOptions() {
    return {
      currency: this.defaults.currency ? this.defaults.currency() : null,
      retentionDays: this.defaults.retentionDays ? this.defaults.retentionDays() : null,
    };
  }

  // Loads every enabled rule and rebuilds the current window from persisted usage events.
  load() {
    this.rulesByToken.clear();
    this.counters.clear();
    const rules = this.db.prepare('SELECT * FROM token_budget_rules WHERE enabled = 1 ORDER BY id').all();
    for (const row of rules) {
      const rule = ruleFromRow(row);
      if (!this.rulesByToken.has(rule.tokenId)) this.rulesByToken.set(rule.tokenId, []);
      this.rulesByToken.get(rule.tokenId).push(rule);
      this.rebuildCounter(rule, Date.now());
    }
  }

  // Sums persisted usage for one rule window, respecting amount-rule currency.
  sumRuleUsage(rule, window) {
    const currency = rule.metric === 'amount' ? rule.currency : null;
    const currencyClause = currency ? ' AND (currency IS NULL OR currency = ?)' : '';
    const params = currency
      ? [rule.tokenId, window.start, window.end, currency]
      : [rule.tokenId, window.start, window.end];
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(requests), 0) AS requests,
              COALESCE(SUM(tokens_in), 0) AS tokens_in,
              COALESCE(SUM(tokens_out), 0) AS tokens_out,
              COALESCE(SUM(downstream_cost), 0) AS downstream_cost
       FROM token_usage_events WHERE token_id = ? AND ts >= ? AND ts < ?${currencyClause}`,
    ).get(...params);
    return actualFor(rule, {
      requests: row.requests,
      tokensIn: row.tokens_in,
      tokensOut: row.tokens_out,
      amount: row.downstream_cost,
    });
  }

  // Rebuilds one rule's counter from token usage events in its current window.
  rebuildCounter(rule, now) {
    const window = ruleWindow(rule, now);
    this.counters.set(rule.id, {
      windowStart: window.start,
      windowEnd: window.end,
      used: this.sumRuleUsage(rule, window),
    });
  }

  // Returns the active rules for a token.
  rulesForToken(tokenId) {
    return this.rulesByToken.get(tokenId) || [];
  }

  // Returns a rule's counter for the current window, rebuilding when the window rolls.
  counterFor(rule, now) {
    const window = ruleWindow(rule, now);
    let counter = this.counters.get(rule.id);
    if (!counter || counter.windowStart !== window.start) {
      counter = {
        windowStart: window.start,
        windowEnd: window.end,
        used: this.sumRuleUsage(rule, window),
      };
      this.counters.set(rule.id, counter);
    }
    return { counter, window };
  }

  // Reserves every enabled rule for one admitted request; returns handles or a rejection reason.
  reserve(token, estimates, now = Date.now()) {
    const rules = this.rulesForToken(token.id);
    if (rules.length === 0) return { ok: true, handles: [] };
    const handles = [];
    for (const rule of rules) {
      const { counter, window } = this.counterFor(rule, now);
      const value = estimateFor(rule, estimates);
      if (counter.used + value > rule.limit_value) {
        this.release(handles);
        return { ok: false, reason: reasonLabel(rule), rule };
      }
      counter.used += value;
      handles.push({
        tokenId: token.id,
        ruleId: rule.id,
        ruleKey: ruleKey(rule),
        windowStart: window.start,
        value,
        metric: rule.metric,
      });
    }
    return { ok: true, handles };
  }

  // Releases reservation estimates that have not been settled.
  release(handles) {
    for (const handle of handles || []) {
      if (handle.released) continue;
      handle.released = true;
      // Only a counter that held the reservation may be reduced. Rule edits
      // carry same-shape counters forward, while changed shapes rebuild theirs.
      let counter = this.counters.get(handle.ruleId);
      if (!counter && handle.tokenId && handle.ruleKey) {
        const rule = this.ruleByKey(handle.tokenId, handle.ruleKey);
        const current = rule ? this.counters.get(rule.id) : null;
        if (current?.inherited) counter = current;
      }
      if (!counter || counter.windowStart !== handle.windowStart) continue;
      counter.used = Math.max(0, counter.used - handle.value);
    }
  }

  // Replaces reservation estimates with actual usage in the current window.
  reconcile(handles, actual, now = Date.now()) {
    for (const handle of handles || []) {
      if (handle.released) continue;
      const rule = this.findRule(handle.ruleId)
        ?? (handle.tokenId && handle.ruleKey ? this.ruleByKey(handle.tokenId, handle.ruleKey) : null);
      if (!rule) continue;
      // Subtract the estimate from the counter that held it. A same-shape rule
      // edit carries that counter forward; a changed shape rebuilds it without
      // the estimate, so there is nothing to subtract.
      let previous = this.counters.get(handle.ruleId);
      if (!previous && handle.tokenId && handle.ruleKey) {
        const current = this.counters.get(rule.id);
        if (current?.inherited) previous = current;
      }
      if (previous && previous.windowStart === handle.windowStart) {
        previous.used = Math.max(0, previous.used - handle.value);
      }
      const { counter } = this.counterFor(rule, now);
      counter.used += actualFor(rule, actual);
    }
  }

  // Finds a rule by id.
  findRule(ruleId) {
    for (const rules of this.rulesByToken.values()) {
      const found = rules.find((rule) => rule.id === ruleId);
      if (found) return found;
    }
    return null;
  }

  // Finds a token's active rule by its stable shape key.
  ruleByKey(tokenId, key) {
    return this.rulesForToken(tokenId).find((rule) => ruleKey(rule) === key) ?? null;
  }

  // Returns the first exhausted rule reason for a token, or null.
  exceeded(token, now = Date.now()) {
    for (const rule of this.rulesForToken(token.id)) {
      const { counter } = this.counterFor(rule, now);
      if (counter.used >= rule.limit_value) return reasonLabel(rule);
    }
    return null;
  }

  // Returns a budget report with rules, remaining headroom, and soft warnings.
  report(token, warnRatio, now = Date.now()) {
    const rules = this.rulesForToken(token.id).map((rule) => {
      const { counter, window } = this.counterFor(rule, now);
      const remaining = Math.max(0, rule.limit_value - counter.used);
      return {
        id: rule.id,
        metric: rule.metric,
        period: rule.period,
        periodLabel: periodLabel(rule),
        periodCount: rule.period_count,
        limit: rule.limit_value,
        used: counter.used,
        remaining,
        resetAt: window.end,
        resetTime: rule.reset_time,
        timezone: rule.timezone,
        anchor: rule.anchor,
        currency: rule.currency,
        reason: reasonLabel(rule),
        warning: counter.used >= rule.limit_value * warnRatio && counter.used < rule.limit_value,
      };
    });
    const usage = { dayRequests: 0, monthRequests: 0, daySpend: 0, monthSpend: 0 };
    const remaining = {};
    const warnings = [];
    for (const rule of rules) {
      if (rule.metric === 'requests' && rule.period === 'day') {
        usage.dayRequests = rule.used;
        remaining.daily_requests = rule.remaining;
      }
      if (rule.metric === 'requests' && rule.period === 'month') {
        usage.monthRequests = rule.used;
        remaining.monthly_requests = rule.remaining;
      }
      if (rule.metric === 'amount' && rule.period === 'day') {
        usage.daySpend = rule.used;
        remaining.daily_spend = rule.remaining;
      }
      if (rule.metric === 'amount' && rule.period === 'month') {
        usage.monthSpend = rule.used;
        remaining.monthly_spend = rule.remaining;
      }
      if (rule.warning) warnings.push(rule.reason);
    }
    const primary = rules.find((rule) => rule.metric === 'amount') ?? rules[0] ?? null;
    return { rules, usage, remaining, warnings, primary };
  }

  // Replaces all rules for a token and rebuilds their counters.
  replaceRules(tokenId, rules) {
    const normalized = normalizeRules(rules, this.ruleOptions());
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.replaceRulesInside(tokenId, normalized);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.reloadToken(tokenId);
  }

  // Writes already-normalized rules inside a caller-owned transaction.
  replaceRulesInside(tokenId, rules) {
    this.db.prepare('DELETE FROM token_budget_rules WHERE token_id = ?').run(tokenId);
    const insert = this.db.prepare(`INSERT INTO token_budget_rules
      (token_id, metric, period, period_count, limit_value, timezone, reset_time, anchor, currency, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const now = Date.now();
    for (const rule of rules) {
      insert.run(tokenId, rule.metric, rule.period, rule.period_count, rule.limit_value,
        rule.timezone, rule.reset_time, rule.anchor, rule.currency, rule.enabled ? 1 : 0, now);
    }
  }

  // Reloads one token's rules and counters, carrying same-shape counters forward.
  reloadToken(tokenId) {
    const previousRules = this.rulesByToken.get(tokenId) || [];
    const inherited = new Map();
    for (const rule of previousRules) {
      const counter = this.counters.get(rule.id);
      if (counter) {
        const key = ruleKey(rule);
        if (!inherited.has(key)) inherited.set(key, []);
        inherited.get(key).push(counter);
      }
      this.counters.delete(rule.id);
    }
    const rows = this.db.prepare('SELECT * FROM token_budget_rules WHERE token_id = ? AND enabled = 1 ORDER BY id').all(tokenId);
    const loaded = rows.map(ruleFromRow);
    const nextKeys = new Map();
    for (const rule of loaded) {
      const key = ruleKey(rule);
      nextKeys.set(key, (nextKeys.get(key) || 0) + 1);
    }
    this.rulesByToken.set(tokenId, loaded);
    for (const rule of loaded) {
      const key = ruleKey(rule);
      const candidates = inherited.get(key);
      const counter = candidates && candidates.length === 1 && nextKeys.get(key) === 1
        ? candidates.shift()
        : null;
      const window = ruleWindow(rule, Date.now());
      if (counter && counter.windowStart === window.start) {
        counter.windowEnd = window.end;
        counter.inherited = true;
        this.counters.set(rule.id, counter);
      } else {
        this.rebuildCounter(rule, Date.now());
      }
    }
    return loaded;
  }
}
