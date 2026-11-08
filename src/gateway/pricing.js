// Best-effort reference pricing per upstream model, per-route overrides, and downstream pricing.
import fs from 'node:fs';

const TABLE = JSON.parse(fs.readFileSync(new URL('./model_prices.json', import.meta.url), 'utf8'))
  .map((entry) => ({ regex: new RegExp(entry.match, 'i'), input: entry.input, output: entry.output }));
const cache = new Map();

// Returns the base model id candidates for matching (full id and last path segment).
function candidates(model) {
  const lower = String(model || '').toLowerCase();
  const base = lower.split('/').pop().split(':')[0];
  return lower === base ? [lower] : [lower, base];
}

// Looks up reference pricing for an upstream model id, or null when unknown.
export function lookupPricing(model) {
  if (!model) return null;
  if (cache.has(model)) return cache.get(model);
  let result = null;
  for (const entry of TABLE) {
    if (candidates(model).some((candidate) => entry.regex.test(candidate))) {
      result = { input: entry.input, output: entry.output };
      break;
    }
  }
  cache.set(model, result);
  return result;
}

// Resolves a route's effective upstream cost per million tokens and where it came from.
export function resolveRouteCost(route) {
  const hasManual = route.inputCostPerM !== null || route.outputCostPerM !== null;
  const auto = route.inputCostPerM === null || route.outputCostPerM === null
    ? lookupPricing(route.upstreamModel)
    : null;
  const input = route.inputCostPerM ?? auto?.input ?? 0;
  const output = route.outputCostPerM ?? auto?.output ?? 0;
  const source = hasManual ? (auto ? 'mixed' : 'manual') : (auto ? 'auto' : 'unknown');
  return { input, output, source };
}

// Returns true when a model carries any explicit downstream price.
export function hasDownstreamPrices(model) {
  return model.downstreamInputCostPerM != null
    || model.downstreamOutputCostPerM != null
    || model.downstreamCachedInputCostPerM != null;
}

// Resolves downstream prices in the billing currency for a model/route pair.
export function resolveDownstreamPrices(model, route, fxRate, currency = 'USD') {
  const billingCurrency = String(currency).toUpperCase();
  const modelCurrency = String(model.downstreamCurrency || 'USD').toUpperCase();
  const upstream = resolveRouteCost(route);
  const hasDownstream = hasDownstreamPrices(model);
  if (hasDownstream && modelCurrency !== billingCurrency) {
    return {
      input: null,
      output: null,
      cachedInput: null,
      upstream,
      source: 'currency_mismatch',
      mismatch: true,
      complete: false,
    };
  }
  const convertedInput = fxRate ? upstream.input * fxRate : null;
  const convertedOutput = fxRate ? upstream.output * fxRate : null;
  const input = model.downstreamInputCostPerM ?? convertedInput;
  const output = model.downstreamOutputCostPerM ?? convertedOutput;
  const cachedInput = model.downstreamCachedInputCostPerM ?? model.downstreamInputCostPerM ?? convertedInput;
  return {
    input,
    output,
    cachedInput,
    upstream,
    source: hasDownstream ? 'downstream' : 'passthrough',
    mismatch: false,
    complete: input !== null && output !== null && cachedInput !== null,
  };
}

// Resolves a single pricing view across every route of a model.
export function modelPricingView(model, routes, fxRate, currency = 'USD') {
  const list = Array.isArray(routes) ? routes : [];
  const hasDownstream = hasDownstreamPrices(model);
  const resolved = list
    .map((route) => resolveDownstreamPrices(model, route, fxRate, currency))
    .filter((prices) => prices.input !== null && prices.output !== null);
  if (resolved.length === 0) {
    const mismatch = list.some((route) => resolveDownstreamPrices(model, route, fxRate, currency).mismatch);
    return {
      input: null, output: null, cachedInput: null,
      inputMin: null, inputMax: null, outputMin: null, outputMax: null,
      cachedInputMin: null, cachedInputMax: null,
      source: mismatch ? 'currency_mismatch' : (hasDownstream ? 'unavailable' : 'passthrough'),
      routeDependent: false,
    };
  }
  const inputs = resolved.map((prices) => prices.input);
  const outputs = resolved.map((prices) => prices.output);
  const cachedInputs = resolved.map((prices) => prices.cachedInput).filter((value) => value !== null);
  const inputMin = Math.min(...inputs);
  const inputMax = Math.max(...inputs);
  const outputMin = Math.min(...outputs);
  const outputMax = Math.max(...outputs);
  if (inputMax > inputMin || outputMax > outputMin) {
    return {
      input: null, output: null, cachedInput: null,
      inputMin, inputMax, outputMin, outputMax,
      cachedInputMin: cachedInputs.length ? Math.min(...cachedInputs) : null,
      cachedInputMax: cachedInputs.length ? Math.max(...cachedInputs) : null,
      source: 'route_dependent',
      routeDependent: true,
    };
  }
  return {
    input: inputMin,
    output: outputMin,
    cachedInput: resolved[0].cachedInput,
    inputMin: null,
    inputMax: null,
    outputMin: null,
    outputMax: null,
    cachedInputMin: null,
    cachedInputMax: null,
    source: hasDownstream ? 'downstream' : 'passthrough',
    routeDependent: false,
  };
}

// Computes the downstream charge in the billing currency for observed token usage.
export function computeDownstreamCost(prices, { inputTokens = 0, outputTokens = 0, cachedTokens = 0 }) {
  if (!prices || prices.input === null || prices.output === null || prices.cachedInput === null) return null;
  const cached = Math.min(Math.max(0, cachedTokens), Math.max(0, inputTokens));
  const billableInput = Math.max(0, inputTokens - cached);
  return (billableInput * prices.input + cached * prices.cachedInput + outputTokens * prices.output) / 1000000;
}

// Returns the largest downstream estimate across a model's routes for amount reservations.
export function maxDownstreamEstimate(model, routes, fxRate, usage, currency = 'USD') {
  let max = null;
  for (const route of routes) {
    const prices = resolveDownstreamPrices(model, route, fxRate, currency);
    const cost = computeDownstreamCost(prices, usage);
    if (cost !== null && (max === null || cost > max)) max = cost;
  }
  return max;
}
