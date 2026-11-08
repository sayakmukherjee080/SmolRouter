// Models section: alias CRUD, balance strategy, and provider route management.
import { api } from '../api.js';
import { escapeHtml, toast, openModal, confirmDialog, routeBadge, fmtCost, fmtNum, fmtRelative, fmtCountdown, emptyState } from '../ui.js';

// Labels a route cost, flagging auto-priced values from the built-in map.
function costLabel(route, direction) {
  const manual = direction === 'input' ? route.inputCostPerM : route.outputCostPerM;
  const resolved = direction === 'input' ? route.resolvedInputCostPerM : route.resolvedOutputCostPerM;
  if (manual !== null && manual !== undefined) return `${fmtCost(manual)}/M`;
  if (route.pricingSource === 'auto' || route.pricingSource === 'mixed') {
    return `${fmtCost(resolved)}/M <span class="badge muted">auto</span>`;
  }
  return '<span class="muted">unknown</span>';
}

// Formats a TPS value with enough precision for near-floor values.
function fmtTps(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return num >= 100 ? num.toFixed(0) : num.toFixed(1);
}

// Renders the TPS-aware routing status for a model card.
function tpsLabel(model, providerName) {
  const tps = model.tps;
  if (!tps?.enabled) return '<span class="badge muted">off</span>';
  const state = tps.degraded
    ? '<span class="badge warn"><span class="dot"></span>Degraded</span>'
    : '<span class="badge ok"><span class="dot"></span>Healthy</span>';
  const route = (model.routes ?? []).find((item) => item.id === tps.preferred_route_id);
  const routeLabel = route
    ? `${escapeHtml(providerName(route.providerId))} · ${escapeHtml(route.upstreamModel)}`
    : '—';
  const speed = tps.effective_tps === null || tps.effective_tps === undefined
    ? '—' : `${fmtTps(tps.effective_tps)} tok/s`;
  const windowSize = tps.window_size ?? 12;
  const samples = `${tps.sample_count ?? 0}/${windowSize} samples`;
  const floor = `floor ${fmtTps(tps.tps_floor)}`;
  const ttft = tps.max_ttft_ms ? ` · TTFT ≤ ${fmtNum(tps.max_ttft_ms)}ms` : '';
  const probe = tps.degraded
    ? (tps.probes_enabled === false
      ? 'probes paused'
      : (tps.next_probe_at ? `next probe ${fmtCountdown(tps.next_probe_at)}` : 'probe pending'))
    : (tps.last_probe_at ? `last probe ${fmtRelative(tps.last_probe_at)}` : '');
  return `${state} <span class="muted small-label">${routeLabel} · ${speed} · ${samples} · ${floor}${ttft}${probe ? ` · ${probe}` : ''}</span>`;
}

// Renders one model card with its downstream prices and route table.
function modelCard(model, providerName, currency) {
  const routes = model.routes ?? [];
  const modelCurrency = model.downstreamCurrency ?? currency;
  const downstream = model.downstreamInputCostPerM === null && model.downstreamOutputCostPerM === null
    ? '<span class="muted">pass-through</span>'
    : `${Number(model.downstreamInputCostPerM ?? 0).toFixed(4)} / ${Number(model.downstreamOutputCostPerM ?? 0).toFixed(4)} ${escapeHtml(modelCurrency)} per M`;
  const rows = routes.map((route) => `
    <tr>
      <td>${escapeHtml(providerName(route.providerId))}</td>
      <td class="mono">${escapeHtml(route.upstreamModel)}</td>
      <td class="num">${route.priority}</td>
      <td class="num">${costLabel(route, 'input')}</td>
      <td class="num">${costLabel(route, 'output')}</td>
      <td class="muted small-label">${route.capabilities?.length ? escapeHtml(route.capabilities.join(', ')) : '—'}</td>
      <td class="num">${route.maxContext ?? '—'}</td>
      <td class="num">${route.dailyQuota ? escapeHtml(route.dailyQuota) : '∞'}</td>
      <td>${routeBadge(route)}</td>
      <td>
        <div class="inline-actions">
          <button class="btn ghost small" data-action="route-edit" data-model="${model.id}" data-route="${route.id}">Edit</button>
          <button class="btn danger small" data-action="route-delete" data-model="${model.id}" data-route="${route.id}" data-label="${escapeHtml(model.name)} → ${escapeHtml(route.upstreamModel)}">Delete</button>
        </div>
      </td>
    </tr>`).join('');

  return `
    <article class="card model-card" data-model="${model.id}">
      <div class="model-head">
        <h3>${escapeHtml(model.name)}</h3>
        <span class="badge muted">alias</span>
        <div class="spacer"></div>
        <label class="row" title="Routing strategy">
          <span class="muted small-label">Strategy</span>
          <select data-action="strategy" data-model="${model.id}">
            <option value="round_robin"${model.balanceStrategy === 'round_robin' ? ' selected' : ''}>Round robin</option>
            <option value="least_used"${model.balanceStrategy === 'least_used' ? ' selected' : ''}>Least used</option>
            <option value="cache_aware"${model.balanceStrategy === 'cache_aware' ? ' selected' : ''}>Cache aware</option>
          </select>
        </label>
        <label class="switch" title="Exact response cache for temperature=0 requests">
          <input type="checkbox" data-action="cache" data-model="${model.id}"${model.cacheEnabled ? ' checked' : ''}>
          <span class="track"></span>
          <span class="muted small-label">Cache</span>
        </label>
        <button class="btn ghost small" data-action="route-add" data-model="${model.id}">Add route</button>
        <button class="btn ghost small" data-action="tps" data-model="${model.id}">TPS</button>
        <button class="btn ghost small" data-action="pricing" data-model="${model.id}">Pricing</button>
        <button class="btn danger small" data-action="model-delete" data-model="${model.id}" data-label="${escapeHtml(model.name)}">Delete</button>
      </div>
      <p class="muted small-label">Downstream: ${downstream}</p>
      <p class="muted small-label">TPS routing: ${tpsLabel(model, providerName)}</p>
      ${routes.length ? `<div class="table-scroll"><table class="route-table">
        <thead><tr><th>Provider</th><th>Upstream model</th><th>Priority</th><th>Input</th><th>Output</th><th>Capabilities</th><th>Max ctx</th><th>Daily cap</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>` : '<p class="muted">No provider routes yet.</p>'}
    </article>`;
}

// Opens the create-model dialog.
function modelModal(onDone) {
  const modal = openModal(`
    <h3>New model</h3>
    <p class="modal-sub">Clients request this alias; routing decisions happen behind it.</p>
    <form id="model-form" class="stack">
      <label class="field"><span>Alias name</span><input name="name" required placeholder="ds-v4.1-flash"></label>
      <label class="field"><span>Balance strategy</span>
        <select name="balanceStrategy">
          <option value="round_robin">Round robin</option>
          <option value="least_used">Least used</option>
          <option value="cache_aware">Cache aware</option>
        </select>
      </label>
      <div class="form-grid">
        <label class="field"><span>Downstream input / M (optional)</span><input name="downstreamInputCostPerM" type="number" min="0" step="0.0001" placeholder="pass-through"></label>
        <label class="field"><span>Downstream output / M (optional)</span><input name="downstreamOutputCostPerM" type="number" min="0" step="0.0001" placeholder="pass-through"></label>
        <label class="field"><span>Downstream cached input / M (optional)</span><input name="downstreamCachedInputCostPerM" type="number" min="0" step="0.0001" placeholder="input price"></label>
      </div>
      <p class="form-error hidden" data-error></p>
      <div class="form-actions">
        <button type="button" class="btn ghost" data-close>Cancel</button>
        <button class="btn primary" type="submit">Create model</button>
      </div>
    </form>`);
  modal.root.querySelector('[data-close]').addEventListener('click', modal.close);
  modal.root.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    try {
      const optional = (value) => (value === '' ? null : Number(value));
      await api('/models', { method: 'POST', body: {
        name: form.name.value,
        balanceStrategy: form.balanceStrategy.value,
        downstreamInputCostPerM: optional(form.downstreamInputCostPerM.value),
        downstreamOutputCostPerM: optional(form.downstreamOutputCostPerM.value),
        downstreamCachedInputCostPerM: optional(form.downstreamCachedInputCostPerM.value),
      } });
      modal.close();
      toast('Model created', 'success');
      onDone();
    } catch (error) {
      const box = form.querySelector('[data-error]');
      box.textContent = error.message;
      box.classList.remove('hidden');
    }
  });
}

// Opens the route create/edit dialog for a model.
async function routeModal(model, providers, onDone, existing = null) {
  const providerOptions = providers.map((provider) =>
    `<option value="${provider.id}"${existing?.providerId === provider.id ? ' selected' : ''}>${escapeHtml(provider.name)}</option>`).join('');
  const modal = openModal(`
    <h3>${existing ? 'Edit route' : 'Add route'}</h3>
    <p class="modal-sub">${escapeHtml(model.name)} routes to one upstream model per provider entry.</p>
    <form id="route-form" class="stack">
      <label class="field"><span>Provider</span>
        <select name="providerId" required>${providerOptions}</select>
      </label>
      <label class="field"><span>Upstream model</span>
        <div class="row">
          <input name="upstreamModel" required list="upstream-models" value="${escapeHtml(existing?.upstreamModel ?? '')}" placeholder="deepseek-v4.1-flash">
          <button type="button" class="btn ghost" data-load-models>Load models</button>
        </div>
        <datalist id="upstream-models"></datalist>
      </label>
      <div class="form-grid">
        <label class="field"><span>Priority tier</span><input name="priority" type="number" min="1" value="${existing?.priority ?? 1}"></label>
        <label class="field"><span>Input $ / M tokens</span><input name="inputCostPerM" type="number" min="0" step="0.01" value="${existing?.inputCostPerM ?? ''}" placeholder="auto"></label>
        <label class="field"><span>Output $ / M tokens</span><input name="outputCostPerM" type="number" min="0" step="0.01" value="${existing?.outputCostPerM ?? ''}" placeholder="auto"></label>
        <label class="field"><span>Cached input $ / M (optional)</span><input name="cachedInputCostPerM" type="number" min="0" step="0.01" value="${existing?.cachedInputCostPerM ?? ''}" placeholder="discount"></label>
        <label class="field"><span>Max context tokens (optional)</span><input name="maxContext" type="number" min="1" value="${existing?.maxContext ?? ''}" placeholder="unlimited"></label>
        <label class="field"><span>Daily request cap (optional)</span><input name="dailyQuota" type="number" min="1" value="${existing?.dailyQuota ?? ''}" placeholder="unlimited"></label>
      </div>
      <div class="field">
        <span>Required capabilities (none selected = any)</span>
        <div class="row wrap">
          ${['tools', 'vision', 'audio', 'json', 'reasoning'].map((capability) => `
            <label class="switch">
              <input type="checkbox" name="capabilities" value="${capability}"${existing?.capabilities?.includes(capability) ? ' checked' : ''}>
              <span class="track"></span>
              <span>${capability}</span>
            </label>`).join('')}
        </div>
      </div>
      <p class="form-error hidden" data-error></p>
      <div class="form-actions">
        <button type="button" class="btn ghost" data-close>Cancel</button>
        <button class="btn primary" type="submit">${existing ? 'Save route' : 'Add route'}</button>
      </div>
    </form>`);
  const form = modal.root.querySelector('form');
  modal.root.querySelector('[data-close]').addEventListener('click', modal.close);
  const datalist = modal.root.querySelector('#upstream-models');
  modal.root.querySelector('[data-load-models]').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Loading…';
    try {
      const { models } = await api(`/providers/${form.providerId.value}/upstream-models`);
      datalist.innerHTML = models.map((item) => `<option value="${escapeHtml(item.id)}"></option>`).join('');
      toast(`${models.length} models loaded`, 'success');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Load models';
    }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = {
      providerId: Number(form.providerId.value),
      upstreamModel: form.upstreamModel.value,
      priority: Number(form.priority.value),
      inputCostPerM: form.inputCostPerM.value === '' ? null : Number(form.inputCostPerM.value),
      outputCostPerM: form.outputCostPerM.value === '' ? null : Number(form.outputCostPerM.value),
      cachedInputCostPerM: form.cachedInputCostPerM.value === '' ? null : Number(form.cachedInputCostPerM.value),
      maxContext: form.maxContext.value === '' ? null : Number(form.maxContext.value),
      dailyQuota: form.dailyQuota.value === '' ? null : Number(form.dailyQuota.value),
      capabilities: [...form.querySelectorAll('input[name="capabilities"]:checked')].map((input) => input.value),
    };
    try {
      if (existing) {
        await api(`/routes/${existing.id}`, { method: 'PATCH', body });
      } else {
        await api(`/models/${model.id}/routes`, { method: 'POST', body });
      }
      modal.close();
      toast(existing ? 'Route updated' : 'Route added', 'success');
      onDone();
    } catch (error) {
      const box = form.querySelector('[data-error]');
      box.textContent = error.message;
      box.classList.remove('hidden');
    }
  });
}

// Opens the downstream pricing dialog for a model.
function pricingModal(model, currency, onDone) {
  const modelCurrency = model.downstreamCurrency ?? currency;
  const modal = openModal(`
    <h3>Downstream pricing: ${escapeHtml(model.name)}</h3>
    <p class="modal-sub">Optional client-facing prices in ${escapeHtml(modelCurrency)} per million tokens. Blank means pass-through to upstream cost.</p>
    <form id="pricing-form" class="stack">
      <div class="form-grid">
        <label class="field"><span>Input / M</span><input name="downstreamInputCostPerM" type="number" min="0" step="0.0001" value="${model.downstreamInputCostPerM ?? ''}" placeholder="pass-through"></label>
        <label class="field"><span>Output / M</span><input name="downstreamOutputCostPerM" type="number" min="0" step="0.0001" value="${model.downstreamOutputCostPerM ?? ''}" placeholder="pass-through"></label>
        <label class="field"><span>Cached input / M</span><input name="downstreamCachedInputCostPerM" type="number" min="0" step="0.0001" value="${model.downstreamCachedInputCostPerM ?? ''}" placeholder="input price"></label>
      </div>
      <p class="form-error hidden" data-error></p>
      <div class="form-actions">
        <button type="button" class="btn ghost" data-close>Cancel</button>
        <button class="btn primary" type="submit">Save pricing</button>
      </div>
    </form>`);
  const form = modal.root.querySelector('form');
  modal.root.querySelector('[data-close]').addEventListener('click', modal.close);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const optional = (value) => (value === '' ? null : Number(value));
    try {
      await api(`/models/${model.id}`, { method: 'PATCH', body: {
        downstreamInputCostPerM: optional(form.downstreamInputCostPerM.value),
        downstreamOutputCostPerM: optional(form.downstreamOutputCostPerM.value),
        downstreamCachedInputCostPerM: optional(form.downstreamCachedInputCostPerM.value),
      } });
      modal.close();
      toast('Pricing updated', 'success');
      onDone();
    } catch (error) {
      const box = form.querySelector('[data-error]');
      box.textContent = error.message;
      box.classList.remove('hidden');
    }
  });
}

// Opens the TPS-aware routing dialog for a model.
function tpsModal(model, providers, onDone) {
  const routes = model.routes ?? [];
  const providerName = (id) => providers.find((provider) => provider.id === id)?.name ?? `#${id}`;
  const currentRoute = routes.find((route) => route.id === model.preferredRouteId);
  const routeOptions = routes.map((route) =>
    `<option value="${route.id}"${currentRoute?.id === route.id ? ' selected' : ''}>${escapeHtml(providerName(route.providerId))} · ${escapeHtml(route.upstreamModel)}</option>`).join('');
  const intervalMinutes = model.tpsProbeIntervalMs ? Math.round(model.tpsProbeIntervalMs / 60000) : '';
  const tps = model.tps ?? {};
  const modal = openModal(`
    <h3>TPS-aware routing: ${escapeHtml(model.name)}</h3>
    <p class="modal-sub">Keep a preferred route while it sustains the floor. After ${tps.demote_count ?? 10} of ${tps.window_size ?? 12} samples fall below the floor, traffic moves to the next available route. A background coding probe restores the preferred route after three passes.</p>
    <form id="tps-form" class="stack">
      <label class="field"><span>Preferred route</span>
        <select name="preferredRouteId">
          <option value="">Off</option>
          ${routeOptions}
        </select>
      </label>
      <div class="form-grid">
        <label class="field"><span>TPS floor (effective tokens/s)</span><input name="tpsFloor" type="number" min="0.1" step="0.1" value="${model.tpsFloor ?? ''}" placeholder="off"></label>
        <label class="field"><span>Max content TTFT (ms, optional)</span><input name="tpsMaxTtftMs" type="number" min="1" step="1" value="${model.tpsMaxTtftMs ?? ''}" placeholder="no gate"></label>
        <label class="field"><span>Probe interval (minutes)</span><input name="tpsProbeIntervalMs" type="number" min="1" max="30" step="1" value="${intervalMinutes}" placeholder="5"></label>
      </div>
      <p class="muted small-label">Probes use ${escapeHtml(tps.probe_budget_per_hour ?? 12)} per route per hour. Automatic probes are ${tps.probes_enabled === false ? 'paused in settings' : 'enabled'}; manual probes still run.</p>
      <p class="form-error hidden" data-error></p>
      <div class="form-actions">
        <button type="button" class="btn ghost" data-probe-now>Probe now</button>
        <button type="button" class="btn ghost" data-close>Cancel</button>
        <button class="btn primary" type="submit">Save TPS routing</button>
      </div>
    </form>`);
  const form = modal.root.querySelector('form');
  const errorBox = form.querySelector('[data-error]');
  modal.root.querySelector('[data-close]').addEventListener('click', modal.close);
  form.preferredRouteId.addEventListener('change', () => {
    if (!form.preferredRouteId.value) form.tpsFloor.value = '';
  });
  form.querySelector('[data-probe-now]').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Probing…';
    try {
      const result = await api(`/models/${model.id}/tps/probe`, { method: 'POST' });
      if (!result.probed) {
        toast(result.reason === 'tps_disabled' ? 'Set a preferred route and floor first' : 'TPS probe unavailable', 'error');
      } else {
        toast(result.passed ? 'Probe passed' : 'Probe failed', result.passed ? 'success' : 'error');
        modal.close();
        onDone();
      }
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Probe now';
    }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const preferredRouteId = form.preferredRouteId.value === '' ? null : Number(form.preferredRouteId.value);
    const tpsFloor = form.tpsFloor.value === '' ? null : Number(form.tpsFloor.value);
    const ttft = form.tpsMaxTtftMs.value === '' ? null : Number(form.tpsMaxTtftMs.value);
    const minutes = form.tpsProbeIntervalMs.value === '' ? null : Number(form.tpsProbeIntervalMs.value);
    if ((tpsFloor !== null || preferredRouteId !== null) && (tpsFloor === null || preferredRouteId === null)) {
      errorBox.textContent = 'Set both a preferred route and a TPS floor, or clear both to disable.';
      errorBox.classList.remove('hidden');
      return;
    }
    try {
      await api(`/models/${model.id}`, { method: 'PATCH', body: {
        preferredRouteId,
        tpsFloor,
        tpsMaxTtftMs: ttft,
        tpsProbeIntervalMs: minutes === null ? null : Math.round(minutes * 60000),
      } });
      modal.close();
      toast('TPS routing updated', 'success');
      onDone();
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.classList.remove('hidden');
    }
  });
}

// Renders the models section and wires its interactions.
export async function render(main, signal) {
  const [{ models }, { providers }, { settings }] = await Promise.all([api('/models'), api('/providers'), api('/settings')]);
  const currency = settings.billing_currency ?? 'USD';
  const providerName = (id) => providers.find((provider) => provider.id === id)?.name ?? `#${id}`;
  main.innerHTML = `
    <div class="page-head section-enter">
      <div>
        <h2>Models</h2>
        <p>Model aliases clients can request. Each alias routes across its provider list.</p>
      </div>
      <button class="btn primary" id="new-model" type="button">New model</button>
    </div>
    <div class="model-grid">
      ${models.length
        ? models.map((model) => modelCard(model, providerName, currency)).join('')
        : emptyState('No models yet', 'Create an alias, then add provider routes to it.')}
    </div>`;

  const rerender = () => render(main, signal);
  document.getElementById('new-model').addEventListener('click', () => modelModal(rerender), { signal });

  main.addEventListener('change', async (event) => {
    const cacheToggle = event.target.closest('[data-action="cache"]');
    if (cacheToggle) {
      try {
        await api(`/models/${cacheToggle.dataset.model}`, { method: 'PATCH', body: { cacheEnabled: cacheToggle.checked } });
        toast(cacheToggle.checked ? 'Response cache enabled' : 'Response cache disabled', 'success');
      } catch (error) {
        toast(error.message, 'error');
        rerender();
      }
      return;
    }
    const select = event.target.closest('[data-action="strategy"]');
    if (!select) return;
    try {
      await api(`/models/${select.dataset.model}`, { method: 'PATCH', body: { balanceStrategy: select.value } });
      toast('Strategy updated', 'success');
    } catch (error) {
      toast(error.message, 'error');
      rerender();
    }
  }, { signal });

  main.addEventListener('click', async (event) => {
    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;
    const action = trigger.dataset.action;
    const model = models.find((item) => item.id === Number(trigger.dataset.model));
    if (action === 'model-delete') {
      const confirmed = await confirmDialog({
        title: 'Delete model',
        message: `Delete "${trigger.dataset.label}" and all of its routes? Clients scoped to it lose access.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!confirmed) return;
      try {
        await api(`/models/${trigger.dataset.model}`, { method: 'DELETE' });
        toast('Model deleted', 'success');
        rerender();
      } catch (error) {
        toast(error.message, 'error');
      }
      return;
    }
    if (action === 'pricing') {
      if (model) pricingModal(model, currency, rerender);
      return;
    }
    if (action === 'tps') {
      if (model) tpsModal(model, providers, rerender);
      return;
    }
    if (action === 'route-add') {
      if (providers.length === 0) {
        toast('Add a provider first', 'error');
        return;
      }
      routeModal(model, providers, rerender);
      return;
    }
    if (action === 'route-edit') {
      const existing = (model?.routes ?? []).find((route) => route.id === Number(trigger.dataset.route));
      if (existing) routeModal(model, providers, rerender, existing);
      return;
    }
    if (action === 'route-delete') {
      const confirmed = await confirmDialog({
        title: 'Delete route',
        message: `Remove route "${trigger.dataset.label}"?`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!confirmed) return;
      try {
        await api(`/routes/${trigger.dataset.route}`, { method: 'DELETE' });
        toast('Route removed', 'success');
        rerender();
      } catch (error) {
        toast(error.message, 'error');
      }
    }
  }, { signal });
}
