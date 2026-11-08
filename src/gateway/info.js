// LiteLLM-compatible model pricing and key quota views.
import { modelEntry } from './models.js';
import { modelPricingView } from './pricing.js';
import { periodText } from './billing_headers.js';

// Builds the model/key info facade bound to the registry and FX converter.
export function createInfo({ registry, config, fx }) {
  // Returns LiteLLM-style model pricing visible to a gateway key.
  async function modelInfo(token) {
    const currency = String(registry.setting('billing_currency', config.billingCurrency)).toUpperCase();
    const fxRate = await fx.rate(currency);
    const allowed = registry.tokenModelIdSet(token.id);
    const data = [];
    for (const model of registry.modelsById.values()) {
      if (!allowed.has(model.id)) continue;
      const routes = registry.routesForModel(model.id);
      const prices = modelPricingView(model, routes, fxRate, currency);
      const entry = modelEntry(model);
      data.push({
        id: model.id,
        model_name: model.name,
        model_info: {
          id: entry.id,
          mode: 'chat',
          input_cost_per_token: prices.input === null ? null : prices.input / 1000000,
          output_cost_per_token: prices.output === null ? null : prices.output / 1000000,
          input_cost_per_million: prices.input,
          output_cost_per_million: prices.output,
          cached_input_cost_per_million: prices.cachedInput,
          cached_input_cost_per_million_min: prices.cachedInputMin,
          cached_input_cost_per_million_max: prices.cachedInputMax,
          input_cost_per_million_min: prices.inputMin,
          input_cost_per_million_max: prices.inputMax,
          output_cost_per_million_min: prices.outputMin,
          output_cost_per_million_max: prices.outputMax,
          pricing_source: prices.source,
          currency,
          max_input_tokens: routes[0]?.maxContext ?? null,
          max_output_tokens: null,
          supported_parameters: routes[0]?.capabilities ?? null,
        },
      });
    }
    return { object: 'list', data };
  }

  // Returns LiteLLM-style quota and spend information for the authenticated key.
  function keyInfo(token) {
    const warnRatio = registry.setting('budget_warn_ratio', config.budgetWarnRatio);
    const report = registry.tokenBudgetReport(token, warnRatio);
    const primary = report.primary;
    const amountRules = report.rules.filter((rule) => rule.metric === 'amount');
    const spend = amountRules.reduce((sum, rule) => sum + Number(rule.used || 0), 0);
    return {
      key: token.label ?? `token-${token.id}`,
      info: {
        key_name: token.label ?? `token-${token.id}`,
        key_alias: token.label ?? null,
        spend,
        max_budget: primary?.metric === 'amount' ? primary.limit : null,
        budget_duration: primary ? periodText(primary) : null,
        budget_reset_at: primary ? new Date(primary.resetAt).toISOString() : null,
        currency: String(registry.setting('billing_currency', config.billingCurrency)).toUpperCase(),
        models: [...registry.tokenModelIdSet(token.id)].map((id) => registry.modelById(id)?.name).filter(Boolean),
        budget_rules: report.rules.map((rule) => ({
          metric: rule.metric,
          period: rule.period,
          period_count: rule.periodCount,
          limit: rule.limit,
          used: rule.used,
          remaining: rule.remaining,
          currency: rule.currency,
          reset_at: new Date(rule.resetAt).toISOString(),
          timezone: rule.timezone,
          anchor: rule.anchor,
        })),
      },
    };
  }

  return { modelInfo, keyInfo };
}
