// Export and merge-import of models, providers, routes, and tokens for migration.
import { decryptSecret } from '../util/crypto.js';
import { ValidationError } from './validate.js';

// Returns the provider row with the given name, or null.
function providerByName(registry, name) {
  for (const provider of registry.providersById.values()) {
    if (provider.name === name) return provider;
  }
  return null;
}

// Serializes the full configuration into a portable bundle.
export function exportBundle(registry, { includeSecrets = false } = {}) {
  const models = registry.listModels().map((model) => ({
    name: model.name,
    balanceStrategy: model.balanceStrategy,
    cacheEnabled: model.cacheEnabled,
    downstreamInputCostPerM: model.downstreamInputCostPerM,
    downstreamOutputCostPerM: model.downstreamOutputCostPerM,
    downstreamCachedInputCostPerM: model.downstreamCachedInputCostPerM,
    downstreamCurrency: model.downstreamCurrency ?? null,
    routes: model.routes.map((route) => ({
      provider: registry.providerById(route.providerId)?.name ?? null,
      upstreamModel: route.upstreamModel,
      priority: route.priority,
      inputCostPerM: route.inputCostPerM,
      outputCostPerM: route.outputCostPerM,
      cachedInputCostPerM: route.cachedInputCostPerM,
      dailyQuota: route.dailyQuota,
      capabilities: route.capabilities,
      maxContext: route.maxContext,
    })),
  }));
  const providers = registry.listProviders().map((provider) => ({
    name: provider.name,
    baseUrl: provider.baseUrl,
    keys: includeSecrets
      ? registry.db.prepare(
        'SELECT label, key_enc, enabled FROM provider_keys WHERE provider_id = ? AND deleted_at IS NULL',
      ).all(provider.id).map((row) => ({ label: row.label, keyEnc: row.key_enc, enabled: Boolean(row.enabled) }))
      : [],
  }));
  const tokens = registry.listTokens().map((token) => ({
    label: token.label,
    enabled: token.enabled,
    keyHash: token.keyHash,
    timezone: token.timezone,
    dailyRequestLimit: token.dailyRequestLimit,
    monthlyRequestLimit: token.monthlyRequestLimit,
    dailySpendLimit: token.dailySpendLimit,
    monthlySpendLimit: token.monthlySpendLimit,
    budgetRules: token.budgetRules,
    modelNames: token.modelIds.map((id) => registry.modelById(id)?.name).filter(Boolean),
  }));
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    secretsIncluded: includeSecrets,
    models,
    providers,
    tokens,
  };
}

// Validates the bundle envelope and record shapes before any writes.
function validateBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || bundle.version !== 1) {
    throw new ValidationError('unsupported bundle version');
  }
  for (const key of ['models', 'providers', 'tokens']) {
    if (!Array.isArray(bundle[key])) throw new ValidationError(`bundle.${key} must be an array`);
  }
  for (const provider of bundle.providers) {
    if (!provider || typeof provider.name !== 'string' || typeof provider.baseUrl !== 'string') {
      throw new ValidationError('each provider requires name and baseUrl');
    }
  }
  for (const model of bundle.models) {
    if (!model || typeof model.name !== 'string') throw new ValidationError('each model requires a name');
    if (model.routes !== undefined && !Array.isArray(model.routes)) {
      throw new ValidationError(`model ${model.name} routes must be an array`);
    }
    for (const cost of [model.downstreamInputCostPerM, model.downstreamOutputCostPerM, model.downstreamCachedInputCostPerM]) {
      if (cost !== undefined && cost !== null) {
        const value = Number(cost);
        if (!Number.isFinite(value) || value < 0) {
          throw new ValidationError(`model ${model.name} downstream prices must be zero or positive`);
        }
      }
    }
    const hasDownstream = model.downstreamInputCostPerM != null
      || model.downstreamOutputCostPerM != null
      || model.downstreamCachedInputCostPerM != null;
    if (hasDownstream && (model.downstreamCurrency === undefined || model.downstreamCurrency === null)) {
      throw new ValidationError(`model ${model.name} has downstream prices but no downstreamCurrency; re-export with currency metadata`);
    }
    for (const route of model.routes || []) {
      if (!route || typeof route.provider !== 'string' || typeof route.upstreamModel !== 'string') {
        throw new ValidationError(`model ${model.name} routes require provider and upstreamModel`);
      }
    }
  }
  for (const token of bundle.tokens) {
    if (!token || typeof token.keyHash !== 'string' || !/^[a-f0-9]{64}$/i.test(token.keyHash)) {
      throw new ValidationError('each token requires a 64-character hex keyHash');
    }
    for (const [key, value] of Object.entries({
      dailyRequestLimit: token.dailyRequestLimit,
      monthlyRequestLimit: token.monthlyRequestLimit,
      dailySpendLimit: token.dailySpendLimit,
      monthlySpendLimit: token.monthlySpendLimit,
    })) {
      if (value !== undefined && value !== null && value !== '') {
        const number = Number(value);
        if (!Number.isFinite(number) || number <= 0) {
          throw new ValidationError(`token ${key} must be a positive number or null`);
        }
      }
    }
    if (token.budgetRules !== undefined && token.budgetRules !== null && !Array.isArray(token.budgetRules)) {
      throw new ValidationError('token budgetRules must be an array');
    }
    for (const rule of token.budgetRules || []) {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
        throw new ValidationError('token budgetRules must contain objects');
      }
      if (rule.metric === 'amount' && (rule.currency === undefined || rule.currency === null)) {
        throw new ValidationError(`token amount rules require currency metadata; re-export with currency metadata`);
      }
    }
  }
}

// Merge-imports a bundle, creating missing records and skipping existing ones.
export function importBundle(registry, bundle) {
  validateBundle(bundle);
  const billingCurrency = String(registry.setting('billing_currency', registry.config.billingCurrency)).toUpperCase();
  for (const model of bundle.models) {
    if (registry.modelByName(model.name)) continue;
    const hasDownstream = model.downstreamInputCostPerM != null
      || model.downstreamOutputCostPerM != null
      || model.downstreamCachedInputCostPerM != null;
    if (hasDownstream && String(model.downstreamCurrency).toUpperCase() !== billingCurrency) {
      throw new ValidationError(`model ${model.name} currency does not match billing currency ${billingCurrency}`);
    }
  }
  for (const token of bundle.tokens) {
    if (registry.tokensByHash.has(token.keyHash)) continue;
    const hasLegacySpend = token.dailySpendLimit != null || token.monthlySpendLimit != null;
    if (hasLegacySpend && (!Array.isArray(token.budgetRules) || token.budgetRules.length === 0)
      && billingCurrency !== 'USD') {
      throw new ValidationError(`token ${token.label ?? token.keyHash} has legacy spend limits without currency metadata`);
    }
    for (const rule of token.budgetRules || []) {
      if (rule?.metric === 'amount' && String(rule.currency).toUpperCase() !== billingCurrency) {
        throw new ValidationError(`token ${token.label ?? token.keyHash} amount rule currency does not match billing currency ${billingCurrency}`);
      }
    }
  }
  const created = { providers: 0, keys: 0, models: 0, routes: 0, tokens: 0 };
  const skipped = { providers: 0, keys: 0, models: 0, routes: 0, tokens: 0 };

  for (const entry of bundle.providers) {
    let provider = providerByName(registry, entry.name);
    if (!provider) {
      provider = registry.createProvider({ name: entry.name, baseUrl: entry.baseUrl });
      created.providers += 1;
    } else {
      skipped.providers += 1;
    }
    const existingKeys = registry.keysByProvider.get(provider.id) || [];
    for (const key of entry.keys || []) {
      const plaintext = decryptSecret(key.keyEnc, registry.config.appSecret);
      if (!plaintext || existingKeys.some((item) => item.label === key.label)) {
        skipped.keys += 1;
        continue;
      }
      registry.addProviderKey(provider.id, { label: key.label, key: plaintext });
      created.keys += 1;
    }
  }

  for (const entry of bundle.models) {
    let model = registry.modelByName(entry.name);
    if (!model) {
      model = registry.createModel({
        name: entry.name,
        balanceStrategy: entry.balanceStrategy ?? 'round_robin',
        cacheEnabled: entry.cacheEnabled !== false,
        downstreamInputCostPerM: entry.downstreamInputCostPerM ?? null,
        downstreamOutputCostPerM: entry.downstreamOutputCostPerM ?? null,
        downstreamCachedInputCostPerM: entry.downstreamCachedInputCostPerM ?? null,
        downstreamCurrency: entry.downstreamCurrency ?? null,
      });
      created.models += 1;
    } else {
      skipped.models += 1;
    }
    const existingRoutes = registry.routesForModel(model.id);
    for (const route of entry.routes || []) {
      const provider = providerByName(registry, route.provider);
      if (!provider) {
        skipped.routes += 1;
        continue;
      }
      const duplicate = existingRoutes.some((item) => item.providerId === provider.id
        && item.upstreamModel === route.upstreamModel);
      if (duplicate) {
        skipped.routes += 1;
        continue;
      }
      try {
        registry.createRoute({
          modelId: model.id,
          providerId: provider.id,
          upstreamModel: route.upstreamModel,
          priority: route.priority,
          inputCostPerM: route.inputCostPerM,
          outputCostPerM: route.outputCostPerM,
          cachedInputCostPerM: route.cachedInputCostPerM,
          dailyQuota: route.dailyQuota,
          capabilities: route.capabilities,
          maxContext: route.maxContext,
        });
        created.routes += 1;
      } catch {
        skipped.routes += 1;
      }
    }
  }

  for (const entry of bundle.tokens) {
    try {
      registry.importToken({
        ...entry,
        budgetRules: Array.isArray(entry.budgetRules) ? entry.budgetRules : null,
      });
      created.tokens += 1;
    } catch {
      skipped.tokens += 1;
    }
  }
  return { created, skipped };
}
