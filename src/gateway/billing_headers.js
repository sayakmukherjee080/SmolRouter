// LiteLLM-compatible budget and cost response headers.
const BUDGET_RULE_HEADER_LIMIT = 12;

export function periodText(rule) {
  if (!rule) return null;
  if (rule.period === 'hour') return '1h';
  if (rule.period === 'n_hours') return `${rule.periodCount}h`;
  if (rule.period === 'day') return '1d';
  if (rule.period === 'n_days') return `${rule.periodCount}d`;
  if (rule.period === 'week') return '7d';
  if (rule.period === 'month') return '1mo';
  return rule.period;
}

// Formats a budget number compactly for headers without collapsing tiny values.
function headerNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  if (number === 0) return '0';
  const magnitude = Math.abs(number);
  const decimals = magnitude >= 0.01 ? 6 : Math.min(12, Math.ceil(-Math.log10(magnitude)) + 2);
  return String(Number(number.toFixed(decimals)));
}

// Adds budget and LiteLLM headers from a token budget report.
export function applyBudgetHeaders(headers, report, modelName = null) {
  if (modelName) headers.set('x-litellm-model-id', modelName);
  if (!report) return;
  const rules = (report.rules || []).slice(0, BUDGET_RULE_HEADER_LIMIT);
  const legacyRemaining = Object.entries(report.remaining || {}).map(([key, value]) => `${key}=${value}`);
  const ruleRemaining = rules.map((rule) => `${rule.metric}_${rule.periodLabel}=${headerNumber(rule.remaining)}`);
  const remaining = [...legacyRemaining, ...ruleRemaining].join(',');
  if (remaining) headers.set('x-budget-remaining', remaining);
  const ruleDetail = rules.map((rule) =>
    `${rule.metric}_${rule.periodLabel}=${headerNumber(rule.remaining)}/${headerNumber(rule.limit)}`);
  if (ruleDetail.length) headers.set('x-budget-rules', ruleDetail.join(','));
  if (report.warnings?.length) headers.set('x-budget-warning', report.warnings.join(','));
  const primary = report.primary;
  if (primary && primary.metric === 'amount') {
    headers.set('x-litellm-key-spend', Number(primary.used).toFixed(6));
    headers.set('x-litellm-key-max-budget', String(primary.limit));
    headers.set('x-litellm-key-remaining-budget', Number(primary.remaining).toFixed(6));
    if (periodText(primary)) headers.set('x-litellm-key-budget-duration', periodText(primary));
    headers.set('x-litellm-key-budget-reset-at', new Date(primary.resetAt).toISOString());
  }
}

// Adds cost headers when the downstream charge is known before the body is sent.
export function applyCostHeaders(headers, downstreamCost) {
  if (downstreamCost === null || downstreamCost === undefined) return;
  const value = Number(downstreamCost).toFixed(6);
  headers.set('x-request-cost', value);
  headers.set('x-litellm-response-cost', value);
}
