// Gateway token mutations, timezone, and unified budget-rule management.
import { randomTokenHex, sha256Hex } from '../util/crypto.js';
import { ValidationError, optionalLimit } from './validate.js';
import { requireModel } from './models.js';
import { normalizeRules } from './budgets.js';

// Returns the active billing currency for newly stored monetary values.
function billingCurrency(registry) {
  return String(registry.setting('billing_currency', registry.config.billingCurrency)).toUpperCase();
}

// Returns the configured budget-event retention in days.
function retentionDays(registry) {
  return registry.setting('token_usage_retention_days', registry.config.tokenUsageRetentionDays);
}

// Builds unified rules from the legacy daily/monthly cap fields.
function legacyRules({ dailyRequestLimit, monthlyRequestLimit, dailySpendLimit, monthlySpendLimit }, timezone = 'UTC', currency = 'USD') {
  const rules = [];
  if (dailyRequestLimit) rules.push({ metric: 'requests', period: 'day', limit_value: dailyRequestLimit, timezone });
  if (monthlyRequestLimit) rules.push({ metric: 'requests', period: 'month', limit_value: monthlyRequestLimit, timezone });
  if (dailySpendLimit) rules.push({ metric: 'amount', period: 'day', limit_value: dailySpendLimit, timezone, currency });
  if (monthlySpendLimit) rules.push({ metric: 'amount', period: 'month', limit_value: monthlySpendLimit, timezone, currency });
  return rules;
}

// Returns raw rule rows for a token, suitable for replaceRules.
function rawRulesFor(registry, tokenId) {
  return registry.budgets.rulesForToken(tokenId).map((rule) => ({
    metric: rule.metric,
    period: rule.period,
    period_count: rule.period_count,
    limit_value: rule.limit_value,
    timezone: rule.timezone,
    reset_time: rule.reset_time,
    anchor: rule.anchor,
    currency: rule.currency,
    enabled: rule.enabled,
  }));
}

// Validates an IANA timezone and returns it.
function requireTimezone(value, fallback = 'UTC') {
  const timezone = String(value ?? fallback);
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
  } catch {
    throw new ValidationError(`invalid timezone: ${timezone}`);
  }
  return timezone;
}

// Normalizes the requested rules before any token write, tagging amount rules.
function rulesForWrite(registry, budgetRules, budgets, zone) {
  if (budgetRules !== null && !Array.isArray(budgetRules)) {
    throw new ValidationError('budgetRules must be an array');
  }
  const currency = billingCurrency(registry);
  const source = budgetRules === null
    ? legacyRules(budgets, zone, currency)
    : budgetRules.map((rule) => ({
      ...rule,
      timezone: rule.timezone ?? zone,
      ...(rule.metric === 'amount' && rule.currency === undefined ? { currency } : {}),
    }));
  return normalizeRules(source, { currency, retentionDays: retentionDays(registry) });
}

// Creates a gateway token, returning the raw secret exactly once.
export function createToken(registry, {
  label = null,
  timezone = 'UTC',
  dailyRequestLimit = null,
  monthlyRequestLimit = null,
  dailySpendLimit = null,
  monthlySpendLimit = null,
  budgetRules = null,
} = {}) {
  const raw = randomTokenHex(24);
  const keyHash = sha256Hex(raw);
  const now = Date.now();
  const zone = requireTimezone(timezone);
  const budgets = {
    dailyRequestLimit: optionalLimit(dailyRequestLimit, 'daily_request_limit', { integer: true }),
    monthlyRequestLimit: optionalLimit(monthlyRequestLimit, 'monthly_request_limit', { integer: true }),
    dailySpendLimit: optionalLimit(dailySpendLimit, 'daily_spend_limit'),
    monthlySpendLimit: optionalLimit(monthlySpendLimit, 'monthly_spend_limit'),
  };
  const rules = rulesForWrite(registry, budgetRules, budgets, zone);
  let id;
  registry.db.exec('BEGIN IMMEDIATE');
  try {
    const info = registry.db.prepare(`INSERT INTO tokens
      (key_hash, label, enabled, daily_request_limit, monthly_request_limit, daily_spend_limit, monthly_spend_limit, timezone, created_at)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`)
      .run(keyHash, label ? String(label).slice(0, 200) : null,
        budgets.dailyRequestLimit, budgets.monthlyRequestLimit,
        budgets.dailySpendLimit, budgets.monthlySpendLimit, zone, now);
    id = Number(info.lastInsertRowid);
    registry.budgets.replaceRulesInside(id, rules);
    registry.db.exec('COMMIT');
  } catch (error) {
    registry.db.exec('ROLLBACK');
    throw error;
  }
  const token = {
    id, keyHash, label, enabled: true,
    timezone: zone, createdAt: now, ...budgets,
  };
  registry.tokensByHash.set(token.keyHash, token);
  registry.tokenModelIds.set(token.id, new Set());
  registry.budgets.reloadToken(token.id);
  return { token, raw };
}

// Updates a token's label, enabled flag, timezone, and budget rules atomically.
export function updateToken(registry, tokenId, patch) {
  const token = findTokenById(registry, tokenId);
  if (!token) throw new ValidationError('token not found');
  const label = patch.label === undefined ? token.label : (patch.label === null ? null : String(patch.label).slice(0, 200));
  const enabled = patch.enabled === undefined ? token.enabled : Boolean(patch.enabled);
  const timezone = patch.timezone === undefined ? token.timezone : requireTimezone(patch.timezone);
  const budgets = {
    dailyRequestLimit: patch.dailyRequestLimit === undefined ? token.dailyRequestLimit : optionalLimit(patch.dailyRequestLimit, 'daily_request_limit', { integer: true }),
    monthlyRequestLimit: patch.monthlyRequestLimit === undefined ? token.monthlyRequestLimit : optionalLimit(patch.monthlyRequestLimit, 'monthly_request_limit', { integer: true }),
    dailySpendLimit: patch.dailySpendLimit === undefined ? token.dailySpendLimit : optionalLimit(patch.dailySpendLimit, 'daily_spend_limit'),
    monthlySpendLimit: patch.monthlySpendLimit === undefined ? token.monthlySpendLimit : optionalLimit(patch.monthlySpendLimit, 'monthly_spend_limit'),
  };

  let nextRules = null;
  if (patch.budgetRules !== undefined && patch.budgetRules !== null && !Array.isArray(patch.budgetRules)) {
    throw new ValidationError('budgetRules must be an array');
  }
  if (Array.isArray(patch.budgetRules)) {
    nextRules = rulesForWrite(registry, patch.budgetRules, budgets, timezone);
  } else if (patch.dailyRequestLimit !== undefined || patch.monthlyRequestLimit !== undefined
    || patch.dailySpendLimit !== undefined || patch.monthlySpendLimit !== undefined) {
    const legacy = legacyRules(budgets, timezone, billingCurrency(registry));
    const custom = rawRulesFor(registry, token.id).filter((rule) => {
      if (rule.metric === 'requests' && ['day', 'month'].includes(rule.period)) return false;
      if (rule.metric === 'amount' && ['day', 'month'].includes(rule.period)) return false;
      return true;
    });
    nextRules = rulesForWrite(registry, [...custom, ...legacy], budgets, timezone);
  }

  registry.db.exec('BEGIN IMMEDIATE');
  try {
    registry.db.prepare(`UPDATE tokens SET label = ?, enabled = ?, daily_request_limit = ?, monthly_request_limit = ?,
      daily_spend_limit = ?, monthly_spend_limit = ?, timezone = ? WHERE id = ?`)
      .run(label, enabled ? 1 : 0, budgets.dailyRequestLimit, budgets.monthlyRequestLimit,
        budgets.dailySpendLimit, budgets.monthlySpendLimit, timezone, token.id);
    if (nextRules !== null) registry.budgets.replaceRulesInside(token.id, nextRules);
    registry.db.exec('COMMIT');
  } catch (error) {
    registry.db.exec('ROLLBACK');
    throw error;
  }
  token.label = label;
  token.enabled = enabled;
  token.timezone = timezone;
  Object.assign(token, budgets);
  if (nextRules !== null) registry.budgets.reloadToken(token.id);
  return token;
}

// Soft-deletes a token, tombstoning its hash so the value can be re-imported later.
export function softDeleteToken(registry, tokenId) {
  const token = findTokenById(registry, tokenId);
  if (!token) throw new ValidationError('token not found');
  const now = Date.now();
  registry.db.exec('BEGIN IMMEDIATE');
  try {
    registry.db.prepare('DELETE FROM token_models WHERE token_id = ?').run(token.id);
    registry.db.prepare('DELETE FROM token_budget_rules WHERE token_id = ?').run(token.id);
    registry.db.prepare("UPDATE tokens SET deleted_at = ?, key_hash = key_hash || ':deleted:' || id WHERE id = ?").run(now, token.id);
    registry.db.exec('COMMIT');
  } catch (error) {
    registry.db.exec('ROLLBACK');
    throw error;
  }
  registry.tokensByHash.delete(token.keyHash);
  registry.tokenModelIds.delete(token.id);
  for (const rule of registry.budgets.rulesForToken(token.id)) registry.budgets.counters.delete(rule.id);
  registry.budgets.rulesByToken.delete(token.id);
}

// Replaces a token's model scope with the provided allowlist.
export function setTokenModels(registry, tokenId, modelIds) {
  const token = findTokenById(registry, tokenId);
  if (!token) throw new ValidationError('token not found');
  const ids = [...new Set((Array.isArray(modelIds) ? modelIds : []).map((id) => Number(id)))];
  for (const id of ids) requireModel(registry, id);
  registry.db.exec('BEGIN IMMEDIATE');
  try {
    registry.db.prepare('DELETE FROM token_models WHERE token_id = ?').run(token.id);
    const insert = registry.db.prepare('INSERT INTO token_models (token_id, model_id) VALUES (?, ?)');
    for (const id of ids) insert.run(token.id, id);
    registry.db.exec('COMMIT');
  } catch (error) {
    registry.db.exec('ROLLBACK');
    throw error;
  }
  registry.tokenModelIds.set(token.id, new Set(ids));
  return [...ids];
}

// Finds a token by numeric id.
export function findTokenById(registry, tokenId) {
  const id = Number(tokenId);
  for (const token of registry.tokensByHash.values()) {
    if (token.id === id) return token;
  }
  return null;
}

// Imports a token with a pre-existing hash (config bundle restore) atomically.
export function importToken(registry, {
  keyHash, label = null, enabled = true, timezone = 'UTC',
  dailyRequestLimit = null, monthlyRequestLimit = null,
  dailySpendLimit = null, monthlySpendLimit = null, modelNames = [], budgetRules = null,
} = {}) {
  const hash = String(keyHash || '').trim();
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) throw new ValidationError('invalid token hash');
  if (registry.tokensByHash.has(hash)) throw new ValidationError('token already exists');
  const zone = requireTimezone(timezone);
  const budgets = {
    dailyRequestLimit: optionalLimit(dailyRequestLimit, 'daily_request_limit', { integer: true }),
    monthlyRequestLimit: optionalLimit(monthlyRequestLimit, 'monthly_request_limit', { integer: true }),
    dailySpendLimit: optionalLimit(dailySpendLimit, 'daily_spend_limit'),
    monthlySpendLimit: optionalLimit(monthlySpendLimit, 'monthly_spend_limit'),
  };
  if (Array.isArray(budgetRules)) {
    for (const rule of budgetRules) {
      if (rule && rule.metric === 'amount' && (rule.currency === undefined || rule.currency === null)) {
        throw new ValidationError('imported amount rules require currency metadata');
      }
    }
  } else if ((budgets.dailySpendLimit !== null || budgets.monthlySpendLimit !== null)
    && billingCurrency(registry) !== 'USD') {
    throw new ValidationError('legacy spend limits without currency metadata cannot be imported into a non-USD billing currency');
  }
  const rules = rulesForWrite(registry, budgetRules, budgets, zone);
  const modelIds = (Array.isArray(modelNames) ? modelNames : [])
    .map((name) => registry.modelByName(String(name))?.id)
    .filter((id) => id !== undefined);
  const now = Date.now();
  let id;
  registry.db.exec('BEGIN IMMEDIATE');
  try {
    const info = registry.db.prepare(`INSERT INTO tokens
      (key_hash, label, enabled, daily_request_limit, monthly_request_limit, daily_spend_limit, monthly_spend_limit, timezone, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(hash, label ? String(label).slice(0, 200) : null, enabled ? 1 : 0,
        budgets.dailyRequestLimit, budgets.monthlyRequestLimit,
        budgets.dailySpendLimit, budgets.monthlySpendLimit, zone, now);
    id = Number(info.lastInsertRowid);
    registry.budgets.replaceRulesInside(id, rules);
    const insertModel = registry.db.prepare('INSERT INTO token_models (token_id, model_id) VALUES (?, ?)');
    for (const modelId of modelIds) insertModel.run(id, modelId);
    registry.db.exec('COMMIT');
  } catch (error) {
    registry.db.exec('ROLLBACK');
    throw error;
  }
  const token = { id, keyHash: hash, label, enabled: Boolean(enabled), timezone: zone, createdAt: now, ...budgets };
  registry.tokensByHash.set(token.keyHash, token);
  registry.tokenModelIds.set(token.id, new Set(modelIds));
  registry.budgets.reloadToken(token.id);
  return token;
}
