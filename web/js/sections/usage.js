// Usage section: requests, tokens, cached savings, response-cache stats, and latency percentiles.
import { api } from '../api.js';
import { escapeHtml, emptyState, fmtNum, fmtCost } from '../ui.js';

// Formats a window start as a short UTC date.
function windowLabel(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// Formats a TPS value with extra precision near the floor.
function fmtTps(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return num >= 100 ? num.toFixed(0) : num.toFixed(1);
}

// Renders the usage section with KPI totals, detail tables, cache stats, and latency.
export async function render(main, signal) {
  const [usageData, { models }, { tokens }, { providers }, { settings }] = await Promise.all([
    api('/usage'), api('/models'), api('/tokens'), api('/providers'), api('/settings'),
  ]);
  const currency = settings.billing_currency ?? 'USD';
  const fmtMoney = (value, code = currency) => `${Number(value || 0).toFixed(4)} ${code}`;
  const usage = usageData.usage;
  const currencySummary = usageData.currencySummary ?? [];
  const maps = {
    model: new Map(models.map((model) => [model.id, model.name])),
    token: new Map(tokens.map((token) => [token.id, token.label ?? `#${token.id}`])),
    provider: new Map(providers.map((provider) => [provider.id, provider.name])),
  };
  const routeNames = new Map();
  for (const model of models) {
    for (const route of model.routes ?? []) {
      const provider = providers.find((item) => item.id === route.providerId);
      routeNames.set(route.id, `${model.name} › ${provider?.name ?? `#${route.providerId}`}`);
    }
  }
  // Resolves a display name for a usage row.
  function entityName(row) {
    if (row.entity === 'route') return routeNames.get(row.entity_id) ?? `route #${row.entity_id}`;
    return maps[row.entity]?.get(row.entity_id) ?? `${row.entity} #${row.entity_id}`;
  }

  const modelRows = usage.filter((row) => row.entity === 'model');
  const totals = modelRows.reduce((acc, row) => ({
    requests: acc.requests + row.requests,
    tokensIn: acc.tokensIn + row.tokens_in,
    tokensOut: acc.tokensOut + row.tokens_out,
    cachedTokens: acc.cachedTokens + row.cached_tokens,
    cost: acc.cost + row.cost,
    upstream: acc.upstream + (row.upstream_cost ?? 0),
    downstream: acc.downstream + (row.downstream_cost ?? 0),
    margin: acc.margin + (row.downstream_cost ?? 0) - (row.upstream_cost ?? row.cost) * (row.fx_rate ?? 1),
    saved: acc.saved + row.saved_cost,
  }), { requests: 0, tokensIn: 0, tokensOut: 0, cachedTokens: 0, cost: 0, upstream: 0, downstream: 0, margin: 0, saved: 0 });

  const cacheStats = usageData.cacheStats ?? [];
  const cacheTotals = cacheStats.reduce((acc, row) => ({
    hits: acc.hits + row.hits,
    misses: acc.misses + row.misses,
    coalesced: acc.coalesced + row.coalesced,
    saved: acc.saved + row.saved_cost,
  }), { hits: 0, misses: 0, coalesced: 0, saved: 0 });
  const cacheLookups = cacheTotals.hits + cacheTotals.misses + cacheTotals.coalesced;
  const hitRate = cacheLookups > 0 ? ((cacheTotals.hits / cacheLookups) * 100).toFixed(1) : '0.0';
  const latency = usageData.latency ?? [];
  const tpsRows = usageData.tps ?? [];
  const downstreamText = currencySummary.length
    ? currencySummary.map((row) => fmtMoney(row.downstream_cost, row.currency ?? currency)).join(' · ')
    : fmtMoney(totals.downstream);
  const marginText = currencySummary.length
    ? currencySummary.map((row) => (row.margin === null
      ? `${row.currency ?? currency}: FX rate missing`
      : fmtMoney(row.margin, row.currency ?? currency))).join(' · ')
    : fmtMoney(totals.margin);

  main.innerHTML = `
    <div class="page-head section-enter">
      <div>
        <h2>Usage</h2>
        <p>Requests, tokens, cache savings, and latency. Content is never captured.</p>
      </div>
      <button class="btn ghost" id="refresh-usage" type="button">Refresh</button>
    </div>
    <div class="kpis">
      <div class="kpi"><div class="label">Requests</div><div class="value">${fmtNum(totals.requests)}</div></div>
      <div class="kpi"><div class="label">Tokens in / out</div><div class="value">${fmtNum(totals.tokensIn)} / ${fmtNum(totals.tokensOut)}</div></div>
      <div class="kpi"><div class="label">Cached tokens</div><div class="value">${fmtNum(totals.cachedTokens)}</div></div>
      <div class="kpi"><div class="label">Estimated upstream</div><div class="value">${fmtCost(totals.cost)}</div></div>
      <div class="kpi"><div class="label">Provider reported</div><div class="value">${totals.upstream > 0 ? fmtCost(totals.upstream) : '—'}</div></div>
      <div class="kpi"><div class="label">Downstream billed</div><div class="value">${escapeHtml(downstreamText)}</div></div>
      <div class="kpi"><div class="label">Margin</div><div class="value">${escapeHtml(marginText)}</div></div>
      <div class="kpi"><div class="label">Saved (provider cache)</div><div class="value">${fmtCost(totals.saved)}</div></div>
    </div>
    ${currencySummary.length > 1 ? `<div class="card mt">
      <div class="page-head"><div><h2>Currency groups</h2><p>Downstream billing and margin stay separate per currency; upstream estimates remain USD.</p></div></div>
      <div class="table-scroll"><table class="data-table">
        <thead><tr><th>Currency</th><th class="num">Requests</th><th class="num">Tokens in</th><th class="num">Tokens out</th><th class="num">Upstream (USD)</th><th class="num">Provider (USD)</th><th class="num">Downstream</th><th class="num">Margin</th></tr></thead>
        <tbody>${currencySummary.map((row) => `
          <tr>
            <td>${escapeHtml(row.currency ?? currency)}</td>
            <td class="num">${fmtNum(row.requests)}</td>
            <td class="num">${fmtNum(row.tokens_in)}</td>
            <td class="num">${fmtNum(row.tokens_out)}</td>
            <td class="num">${fmtCost(row.cost)}</td>
            <td class="num">${row.upstream_cost > 0 ? fmtCost(row.upstream_cost) : '—'}</td>
            <td class="num">${fmtMoney(row.downstream_cost, row.currency ?? currency)}</td>
            <td class="num">${row.margin === null ? '<span class="muted">FX rate missing</span>' : fmtMoney(row.margin, row.currency ?? currency)}</td>
          </tr>`).join('')}</tbody>
      </table></div>
    </div>` : ''}
    <div class="card">
      ${usage.length ? `<div class="table-scroll"><table class="data-table">
        <thead><tr><th>Day</th><th>Type</th><th>Name</th><th class="num">Requests</th><th class="num">Tokens in</th><th class="num">Tokens out</th><th class="num">Cached</th><th class="num">Upstream</th><th class="num">Provider</th><th class="num">Downstream</th><th class="num">Saved</th></tr></thead>
        <tbody>${usage.map((row) => `
          <tr>
            <td>${windowLabel(row.window_start)}</td>
            <td><span class="badge muted">${escapeHtml(row.entity)}</span></td>
            <td>${escapeHtml(entityName(row))}</td>
            <td class="num">${fmtNum(row.requests)}</td>
            <td class="num">${fmtNum(row.tokens_in)}</td>
            <td class="num">${fmtNum(row.tokens_out)}</td>
            <td class="num">${fmtNum(row.cached_tokens)}</td>
            <td class="num">${fmtCost(row.cost)}</td>
            <td class="num">${row.upstream_cost === null || row.upstream_cost === undefined ? '—' : fmtCost(row.upstream_cost)}</td>
            <td class="num">${fmtMoney(row.downstream_cost, row.currency ?? currency)}</td>
            <td class="num">${fmtCost(row.saved_cost)}</td>
          </tr>`).join('')}</tbody>
      </table></div>` : emptyState('No usage yet', 'Data appears after the gateway processes requests.')}
    </div>
    <div class="card mt">
      <div class="page-head">
        <div><h2>Response cache</h2><p>Exact-match cache for temperature=0 requests, per UTC day.</p></div>
        <div class="badge ${cacheTotals.saved > 0 ? 'ok' : 'muted'}">${hitRate}% hit rate · ${fmtCost(cacheTotals.saved)} saved</div>
      </div>
      ${cacheStats.length ? `<div class="table-scroll"><table class="data-table">
        <thead><tr><th>Model</th><th class="num">Hits</th><th class="num">Misses</th><th class="num">Coalesced</th><th class="num">Saved</th></tr></thead>
        <tbody>${cacheStats.map((row) => `
          <tr>
            <td>${escapeHtml(row.model ?? `#${row.model_id}`)}</td>
            <td class="num">${fmtNum(row.hits)}</td>
            <td class="num">${fmtNum(row.misses)}</td>
            <td class="num">${fmtNum(row.coalesced)}</td>
            <td class="num">${fmtCost(row.saved_cost)}</td>
          </tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted">No cache activity yet.</p>'}
    </div>
    <div class="card mt">
      <div class="page-head">
        <div><h2>TPS (24h)</h2><p>Validated real-traffic samples. Effective TPS includes time to first output.</p></div>
      </div>
      ${tpsRows.length ? `<div class="table-scroll"><table class="data-table">
        <thead><tr><th>Model</th><th>Provider</th><th>Upstream</th><th class="num">Samples</th><th class="num">Effective TPS</th><th class="num">Content TPS</th><th class="num">TTFT</th></tr></thead>
        <tbody>${tpsRows.map((row) => `
          <tr>
            <td>${escapeHtml(row.model)}</td>
            <td>${escapeHtml(row.provider)}</td>
            <td class="mono">${escapeHtml(row.upstreamModel ?? '—')}</td>
            <td class="num">${fmtNum(row.samples)}</td>
            <td class="num">${row.effectiveTps === null ? '—' : fmtTps(row.effectiveTps)}</td>
            <td class="num">${row.contentTps === null ? '—' : fmtTps(row.contentTps)}</td>
            <td class="num">${row.ttftMs === null ? '—' : `${fmtNum(row.ttftMs)}ms`}</td>
          </tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted">No valid TPS samples in the last 24 hours.</p>'}
    </div>
    <div class="card mt">
      <div class="page-head">
        <div><h2>Latency (24h)</h2><p>Successful attempts, milliseconds.</p></div>
      </div>
      ${latency.length ? `<div class="table-scroll"><table class="data-table">
        <thead><tr><th>Model</th><th>Provider</th><th class="num">Requests</th><th class="num">p50</th><th class="num">p95</th></tr></thead>
        <tbody>${latency.map((row) => `
          <tr>
            <td>${escapeHtml(row.model)}</td>
            <td>${escapeHtml(row.provider)}</td>
            <td class="num">${fmtNum(row.requests)}</td>
            <td class="num">${fmtNum(row.p50)}ms</td>
            <td class="num">${fmtNum(row.p95)}ms</td>
          </tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted">No completed requests in the last 24 hours.</p>'}
    </div>`;

  document.getElementById('refresh-usage').addEventListener('click', () => render(main, signal), { signal });
}
