// Tokens section: gateway keys, timezone, unified budget rules, scope, and revocation.
import { api } from '../api.js';
import { escapeHtml, toast, openModal, confirmDialog, fmtDate, fmtNum, emptyState } from '../ui.js';

const METRICS = [['requests', 'Requests'], ['tokens_in', 'Tokens in'], ['tokens_out', 'Tokens out'], ['tokens_total', 'Tokens total'], ['amount', 'Amount']];
const PERIODS = [['hour', 'Hourly'], ['5h', 'Every 5 hours'], ['n_hours', 'Every N hours'], ['day', 'Daily'], ['n_days', 'Every N days'], ['week', 'Weekly'], ['month', 'Monthly']];

// Converts minutes since midnight to an input[type=time] value.
function minutesToTime(minutes) {
  const value = Math.max(0, Math.min(1439, Number(minutes) || 0));
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

// Converts an input[type=time] value to minutes since midnight.
function timeToMinutes(value) {
  const [hours, minutes] = String(value || '00:00').split(':').map(Number);
  return (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0);
}

// Maps a stored rule period to the editor's period value.
function editorPeriod(rule) {
  if (rule.period === 'n_hours') return rule.periodCount === 5 ? '5h' : 'n_hours';
  return rule.period;
}

// Returns the anchor field HTML for a period.
function anchorField(period, value) {
  if (period === 'week') {
    return `<label class="field" data-field="anchor"><span>Anchor weekday (0=Sun)</span><input name="anchor" type="number" min="0" max="6" value="${value ?? 1}"></label>`;
  }
  if (period === 'month') {
    return `<label class="field" data-field="anchor"><span>Anchor day (1-31)</span><input name="anchor" type="number" min="1" max="31" value="${value ?? 1}"></label>`;
  }
  if (period === 'n_days') {
    return `<label class="field" data-field="anchor"><span>Anchor date</span><input name="anchor" type="date" value="${value ?? new Date().toISOString().slice(0, 10)}"></label>`;
  }
  if (period === 'n_hours') {
    return `<label class="field" data-field="anchor"><span>Anchor hour (0-23)</span><input name="anchor" type="number" min="0" max="23" value="${value ?? 0}"></label>`;
  }
  return `<label class="field hidden" data-field="anchor"><span>Anchor</span><input name="anchor" type="text" value="${value ?? ''}"></label>`;
}

// Renders one budget-rule editor row.
function ruleRow(rule = {}) {
  const period = rule.period ? editorPeriod(rule) : 'day';
  const count = rule.periodCount ?? (period === '5h' ? 5 : 30);
  const reset = minutesToTime(rule.resetTime ?? 0);
  const metric = rule.metric ?? 'requests';
  return `
    <div class="card" data-rule>
      <div class="form-grid">
        <label class="field"><span>Metric</span>
          <select name="metric">${METRICS.map(([value, label]) => `<option value="${value}"${metric === value ? ' selected' : ''}>${label}</option>`).join('')}</select>
        </label>
        <label class="field"><span>Period</span>
          <select name="period">${PERIODS.map(([value, label]) => `<option value="${value}"${period === value ? ' selected' : ''}>${label}</option>`).join('')}</select>
        </label>
        <label class="field"><span>Limit</span><input name="limit" type="number" min="0.000001" step="any" value="${rule.limit ?? rule.limit_value ?? ''}" placeholder="0"></label>
        <label class="field" data-field="count"><span>Every N</span><input name="periodCount" type="number" min="1" max="1000" value="${count}"></label>
        <label class="field" data-field="reset"><span>Reset time</span><input name="resetTime" type="time" value="${reset}"></label>
        ${anchorField(period, rule.anchor)}
      </div>
      <div class="row"><div class="spacer"></div><button type="button" class="btn danger small" data-remove-rule>Remove</button></div>
    </div>`;
}

// Shows/hides period-specific fields inside a rule row.
function syncRuleRow(row) {
  const period = row.querySelector('[name="period"]').value;
  row.querySelector('[data-field="count"]').classList.toggle('hidden', !(period === 'n_hours' || period === 'n_days'));
  row.querySelector('[data-field="reset"]').classList.toggle('hidden', !(period === 'day' || period === 'n_days' || period === 'week' || period === 'month'));
  row.querySelector('[data-field="anchor"]').classList.toggle('hidden', !(period === 'n_hours' || period === 'n_days' || period === 'week' || period === 'month'));
  if (period === '5h') {
    const count = row.querySelector('[name="periodCount"]');
    if (count) count.value = '5';
  }
}

// Wires add/remove/period changes for a rule editor.
function bindRuleEditor(modal) {
  modal.root.addEventListener('change', (event) => {
    const row = event.target.closest('[data-rule]');
    if (row && event.target.name === 'period') syncRuleRow(row);
  });
  modal.root.addEventListener('click', (event) => {
    if (event.target.closest('[data-add-rule]')) {
      const container = modal.root.querySelector('[data-rules]');
      container.insertAdjacentHTML('beforeend', ruleRow());
      syncRuleRow(container.lastElementChild);
      return;
    }
    const remove = event.target.closest('[data-remove-rule]');
    if (remove) {
      const rows = modal.root.querySelectorAll('[data-rule]');
      if (rows.length > 1) remove.closest('[data-rule]').remove();
    }
  });
  for (const row of modal.root.querySelectorAll('[data-rule]')) syncRuleRow(row);
}

// Reads budget rules from the editor; blank limits are ignored.
function readRules(form) {
  const rules = [];
  for (const row of form.querySelectorAll('[data-rule]')) {
    const limit = Number(row.querySelector('[name="limit"]').value);
    if (!Number.isFinite(limit) || limit <= 0) continue;
    const periodValue = row.querySelector('[name="period"]').value;
    let period = periodValue;
    let periodCount = 1;
    if (periodValue === '5h') { period = 'n_hours'; periodCount = 5; }
    else if (periodValue === 'n_hours') { period = 'n_hours'; periodCount = Number(row.querySelector('[name="periodCount"]').value); }
    else if (periodValue === 'n_days') { period = 'n_days'; periodCount = Number(row.querySelector('[name="periodCount"]').value); }
    const resetTime = ['day', 'n_days', 'week', 'month'].includes(periodValue)
      ? timeToMinutes(row.querySelector('[name="resetTime"]').value) : 0;
    const anchorInput = row.querySelector('[name="anchor"]');
    let anchor = anchorInput && !anchorInput.closest('.hidden') ? anchorInput.value : null;
    if (periodValue === 'week' || periodValue === 'month' || periodValue === 'n_hours') anchor = Number(anchor);
    rules.push({
      metric: row.querySelector('[name="metric"]').value,
      period,
      period_count: periodCount,
      limit_value: limit,
      reset_time: resetTime,
      anchor,
      timezone: form.timezone?.value || 'UTC',
    });
  }
  return rules;
}

// Formats a monetary amount without collapsing small nonzero limits to zero.
function amountValue(value) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number === 0) return '0';
  const magnitude = Math.abs(number);
  const decimals = magnitude >= 1 ? 2 : Math.min(12, Math.ceil(-Math.log10(magnitude)) + 2);
  return number.toFixed(decimals).replace(/\.?0+$/, '');
}

// Formats a rule for the token list.
function ruleSummary(rule) {
  const used = Number(rule.used ?? 0);
  const limit = Number(rule.limit ?? rule.limit_value ?? 0);
  const suffix = rule.metric === 'amount' && rule.currency ? ` ${rule.currency}` : '';
  const value = rule.metric === 'amount'
    ? `${amountValue(used)} / ${amountValue(limit)}${suffix}`
    : `${fmtNum(used)} / ${fmtNum(limit)}`;
  return `${value} ${rule.metric} · ${rule.periodLabel ?? rule.period}`;
}

// Opens the reveal-once dialog for a newly created raw key.
function revealModal(raw) {
  const modal = openModal(`
    <h3>Gateway key created</h3>
    <p class="modal-sub">Copy this key now. It is shown once and stored only as a hash.</p>
    <div class="key-reveal" id="raw-key">${escapeHtml(raw)}</div>
    <div class="form-actions">
      <button class="btn ghost" data-copy>Copy</button>
      <button class="btn primary" data-close>Done</button>
    </div>`);
  modal.root.querySelector('[data-copy]').addEventListener('click', async () => {
    await navigator.clipboard.writeText(raw);
    toast('Key copied', 'success');
  });
  modal.root.querySelector('[data-close]').addEventListener('click', modal.close);
}

// Opens the create-token dialog.
function createModal(onDone) {
  const modal = openModal(`
    <h3>New gateway key</h3>
    <p class="modal-sub">Clients send this key as a Bearer token. Budget rules are optional.</p>
    <form id="token-form" class="stack">
      <label class="field"><span>Label</span><input name="label" placeholder="opencode-laptop"></label>
      <label class="field"><span>Timezone</span><input name="timezone" value="UTC" placeholder="Asia/Kolkata"></label>
      <div class="stack" data-rules>${ruleRow()}</div>
      <div class="row"><div class="spacer"></div><button type="button" class="btn ghost small" data-add-rule>Add rule</button></div>
      <p class="form-error hidden" data-error></p>
      <div class="form-actions">
        <button type="button" class="btn ghost" data-close>Cancel</button>
        <button class="btn primary" type="submit">Create key</button>
      </div>
    </form>`);
  bindRuleEditor(modal);
  modal.root.querySelector('[data-close]').addEventListener('click', modal.close);
  modal.root.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    try {
      const data = await api('/tokens', { method: 'POST', body: {
        label: form.label.value || null,
        timezone: form.timezone.value || 'UTC',
        budgetRules: readRules(form),
      } });
      modal.close();
      revealModal(data.raw);
      onDone();
    } catch (error) {
      const box = modal.root.querySelector('[data-error]');
      box.textContent = error.message;
      box.classList.remove('hidden');
    }
  });
}

// Opens the budget/rule edit dialog for a token.
function budgetsModal(token, onDone) {
  const rules = token.budgetRules?.length ? token.budgetRules : [{}];
  const modal = openModal(`
    <h3>Budgets: ${escapeHtml(token.label ?? `token #${token.id}`)}</h3>
    <p class="modal-sub">Rules reset independently. Times use the token timezone.</p>
    <form id="budget-form" class="stack">
      <label class="field"><span>Timezone</span><input name="timezone" value="${escapeHtml(token.timezone ?? 'UTC')}"></label>
      <div class="stack" data-rules>${rules.map((rule) => ruleRow(rule)).join('')}</div>
      <div class="row"><div class="spacer"></div><button type="button" class="btn ghost small" data-add-rule>Add rule</button></div>
      <p class="form-error hidden" data-error></p>
      <div class="form-actions">
        <button type="button" class="btn ghost" data-close>Cancel</button>
        <button class="btn primary" type="submit">Save budgets</button>
      </div>
    </form>`);
  bindRuleEditor(modal);
  modal.root.querySelector('[data-close]').addEventListener('click', modal.close);
  modal.root.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    try {
      await api(`/tokens/${token.id}`, { method: 'PATCH', body: {
        timezone: form.timezone.value || 'UTC',
        budgetRules: readRules(form),
      } });
      modal.close();
      toast('Budgets updated', 'success');
      onDone();
    } catch (error) {
      const box = modal.root.querySelector('[data-error]');
      box.textContent = error.message;
      box.classList.remove('hidden');
    }
  });
}

// Opens the model-scope dialog for a token.
function scopeModal(token, models, onDone) {
  const checked = new Set(token.modelIds);
  const modal = openModal(`
    <h3>Scope: ${escapeHtml(token.label ?? `token #${token.id}`)}</h3>
    <p class="modal-sub">Only the selected models are visible and callable with this key.</p>
    <div class="stack">
      ${models.length ? models.map((model) => `
        <label class="switch">
          <input type="checkbox" value="${model.id}"${checked.has(model.id) ? ' checked' : ''}>
          <span class="track"></span>
          <span>${escapeHtml(model.name)}</span>
        </label>`).join('') : '<p class="muted">No models exist yet.</p>'}
    </div>
    <div class="form-actions">
      <button class="btn ghost" data-close>Cancel</button>
      <button class="btn primary" data-save>Save scope</button>
    </div>`);
  modal.root.querySelector('[data-close]').addEventListener('click', modal.close);
  modal.root.querySelector('[data-save]').addEventListener('click', async () => {
    const modelIds = [...modal.root.querySelectorAll('input[type="checkbox"]:checked')].map((input) => Number(input.value));
    try {
      await api(`/tokens/${token.id}/models`, { method: 'PUT', body: { modelIds } });
      modal.close();
      toast('Scope updated', 'success');
      onDone();
    } catch (error) {
      toast(error.message, 'error');
    }
  });
}

// Summarizes a token's budget rules for the list.
function budgetSummary(token) {
  const rules = token.budgetRules ?? [];
  if (rules.length === 0) return 'unlimited';
  return rules.map(ruleSummary).join(' · ');
}

// Renders the tokens section and wires its interactions.
export async function render(main, signal) {
  const [{ tokens }, { models }] = await Promise.all([api('/tokens'), api('/models')]);
  const modelNames = new Map(models.map((model) => [model.id, model.name]));
  main.innerHTML = `
    <div class="page-head section-enter">
      <div>
        <h2>Gateway keys</h2>
        <p>Bearer keys for client applications; each key sees only its scoped models and optional budget rules.</p>
      </div>
      <button class="btn primary" id="new-token" type="button">New key</button>
    </div>
    <div class="card">
      ${tokens.length ? `<div class="table-scroll"><table class="data-table">
        <thead><tr><th>Label</th><th>Status</th><th>Scoped models</th><th>Budgets</th><th>Reset</th><th>Created</th><th></th></tr></thead>
        <tbody>${tokens.map((token) => `
          <tr>
            <td>${escapeHtml(token.label ?? `token #${token.id}`)}</td>
            <td><span class="badge ${token.enabled ? 'ok' : 'muted'}"><span class="dot"></span>${token.enabled ? 'Enabled' : 'Disabled'}</span></td>
            <td>${token.modelIds.length ? escapeHtml(token.modelIds.map((id) => modelNames.get(id) ?? `#${id}`).join(', ')) : '<span class="muted">none</span>'}</td>
            <td class="muted">${token.budgetWarnings?.length ? '<span class="badge warn">near limit</span> ' : ''}${escapeHtml(budgetSummary(token))}</td>
            <td class="muted">${escapeHtml(token.timezone ?? 'UTC')}</td>
            <td class="muted">${fmtDate(token.createdAt)}</td>
            <td><div class="inline-actions">
              <button class="btn ghost small" data-action="budgets" data-id="${token.id}">Budgets</button>
              <button class="btn ghost small" data-action="scope" data-id="${token.id}">Scope</button>
              <button class="btn ghost small" data-action="toggle" data-id="${token.id}" data-enabled="${token.enabled}">${token.enabled ? 'Disable' : 'Enable'}</button>
              <button class="btn danger small" data-action="delete" data-id="${token.id}" data-label="${escapeHtml(token.label ?? `#${token.id}`)}">Delete</button>
            </div></td>
          </tr>`).join('')}</tbody>
      </table></div>` : emptyState('No gateway keys', 'Create a key, then scope it to the models a client may use.')}
    </div>`;

  const rerender = () => render(main, signal);
  document.getElementById('new-token').addEventListener('click', () => createModal(rerender), { signal });

  main.addEventListener('click', async (event) => {
    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;
    const token = tokens.find((item) => item.id === Number(trigger.dataset.id));
    if (trigger.dataset.action === 'budgets' && token) {
      budgetsModal(token, rerender);
      return;
    }
    if (trigger.dataset.action === 'scope' && token) {
      scopeModal(token, models, rerender);
      return;
    }
    if (trigger.dataset.action === 'toggle' && token) {
      try {
        await api(`/tokens/${token.id}`, { method: 'PATCH', body: { enabled: trigger.dataset.enabled !== 'true' } });
        toast('Key updated', 'success');
        rerender();
      } catch (error) {
        toast(error.message, 'error');
      }
      return;
    }
    if (trigger.dataset.action === 'delete' && token) {
      const confirmed = await confirmDialog({
        title: 'Delete gateway key',
        message: `Delete "${trigger.dataset.label}"? Clients using it lose access immediately.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!confirmed) return;
      try {
        await api(`/tokens/${token.id}`, { method: 'DELETE' });
        toast('Key deleted', 'success');
        rerender();
      } catch (error) {
        toast(error.message, 'error');
      }
    }
  }, { signal });
}
