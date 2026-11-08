// TPS-aware routing: preferred-route selection, demotion, and recovery scheduling.
import { createTpsProbe } from './tps_probe.js';
import { isValidTpsSample } from './tps_validity.js';
import {
  TPS_WINDOW_SIZE, TPS_DEMOTE_COUNT, TPS_MIN_CONTENT_TOKENS, TPS_STALE_SAMPLE_MS,
  TPS_RESTORE_STREAK, TPS_RESTORE_MULTIPLIER, TPS_MIN_PROBE_INTERVAL_MS,
  TPS_MAX_PROBE_INTERVAL_MS,
} from '../util/tps_limits.js';

const HOUR_MS = 3600000;
const BUDGET_RETRY_MS = 60000;

// Creates the TPS controller bound to the registry, telemetry, and logging.
export function createTpsController({
  registry, config, telemetry, logger, metrics, fetchImpl = fetch, onStateChange,
}) {
  const states = new Map();
  const budget = new Map();
  let timer = null;
  let running = false;
  let stopped = false;
  const probe = createTpsProbe({
    registry, config, telemetry, logger, metrics, fetchImpl, isStopped: () => stopped,
  });

  // Returns whether automatic recovery probes are enabled globally.
  function probesEnabled() {
    return registry.setting('probe_enabled', config.probeEnabled) !== false;
  }

  // Returns the allowed TPS probes per hour for one route.
  function hourlyProbeBudget() {
    return registry.setting('probe_budget_per_hour', config.probeBudgetPerHour);
  }

  // Returns the probes used by a route in the last hour.
  function probeBudgetUsed(routeId, now = Date.now()) {
    return (budget.get(routeId) || []).filter((ts) => ts > now - HOUR_MS).length;
  }

  // Checks and records one probe against the per-route hourly budget.
  function allowProbeBudget(routeId, now) {
    const limit = hourlyProbeBudget();
    const hits = (budget.get(routeId) || []).filter((ts) => ts > now - HOUR_MS);
    budget.set(routeId, hits);
    if (hits.length >= limit) return false;
    hits.push(now);
    return true;
  }

  // Returns true when the model has a usable preferred route and a positive floor.
  function enabledFor(model) {
    const floor = Number(model?.tpsFloor);
    return Number.isFinite(floor) && floor > 0 && model.preferredRouteId !== null
      && model.preferredRouteId !== undefined;
  }

  // Returns the model's preferred route, or null when TPS routing is inactive.
  function preferredRoute(model) {
    if (!enabledFor(model)) return null;
    const route = registry.routeByIdOrNull(model.preferredRouteId);
    if (!route || route.modelId !== model.id) return null;
    return route;
  }

  // Returns the effective probe interval for a model.
  function probeInterval(model) {
    const value = Number(model.tpsProbeIntervalMs);
    if (Number.isFinite(value) && value >= TPS_MIN_PROBE_INTERVAL_MS && value <= TPS_MAX_PROBE_INTERVAL_MS) {
      return Math.trunc(value);
    }
    return config.tpsProbeIntervalMs;
  }

  // Returns the mutable state for a route, creating it when absent.
  function stateFor(routeId) {
    let state = states.get(routeId);
    if (!state) {
      state = {
        samples: [],
        degraded: false,
        restoreStreak: 0,
        lastProbeAt: 0,
        lastProbeTps: null,
        nextProbeAt: 0,
      };
      states.set(routeId, state);
    }
    return state;
  }

  // Drops samples older than the freshness horizon.
  function recentSamples(state, now) {
    return state.samples.filter((sample) => now - sample.ts <= TPS_STALE_SAMPLE_MS);
  }

  // Demotes a preferred route when enough recent samples are below its floor.
  function evaluateDemotion(state, model, now) {
    if (state.degraded) return;
    const recent = recentSamples(state, now);
    if (recent.length < TPS_WINDOW_SIZE) return;
    const below = recent.filter((sample) => sample.effectiveTps < Number(model.tpsFloor)).length;
    if (below < TPS_DEMOTE_COUNT) return;
    state.degraded = true;
    state.restoreStreak = 0;
    state.lastProbeAt = 0;
    state.lastProbeTps = null;
    state.nextProbeAt = now + probeInterval(model);
    logger?.info('tps route demoted', {
      routeId: model.preferredRouteId, modelId: model.id, below, window: recent.length, floor: model.tpsFloor,
    });
    onStateChange?.(model.id);
    schedule();
  }

  // Re-evaluates a route after its floor or sample set changed.
  function reconcileState(state, model, now = Date.now()) {
    if (!state.degraded) {
      evaluateDemotion(state, model, now);
      return;
    }
    const recent = recentSamples(state, now);
    if (recent.length < TPS_WINDOW_SIZE) return;
    const below = recent.filter((sample) => sample.effectiveTps < Number(model.tpsFloor)).length;
    if (below >= TPS_DEMOTE_COUNT) return;
    state.degraded = false;
    state.restoreStreak = 0;
    state.lastProbeAt = 0;
    state.lastProbeTps = null;
    state.nextProbeAt = 0;
    state.samples = [];
    logger?.info('tps route restored by configuration change', {
      routeId: model.preferredRouteId, modelId: model.id, below, floor: model.tpsFloor,
    });
    onStateChange?.(model.id);
    schedule();
  }

  // Records one real request sample for a route, ignoring probes and fallback traffic.
  function recordSample(route, sample, ts = Date.now()) {
    const model = registry.modelById(route.modelId);
    if (!model || !enabledFor(model) || model.preferredRouteId !== route.id) return false;
    const state = stateFor(route.id);
    if (state.degraded || !isValidTpsSample(sample, { maxTtftMs: model.tpsMaxTtftMs })) return false;
    state.samples.push({
      ts,
      effectiveTps: sample.effectiveTps,
      contentTps: sample.contentTps ?? null,
      contentTtftMs: sample.contentTtftMs ?? null,
      contentTokens: sample.contentTokens,
      cachedTokens: sample.cachedTokens ?? 0,
    });
    state.samples = recentSamples(state, ts).slice(-TPS_WINDOW_SIZE);
    evaluateDemotion(state, model, ts);
    return true;
  }

  // Returns the current TPS status for a model, including its preferred route state.
  function status(model) {
    const route = preferredRoute(model);
    const now = Date.now();
    if (!route) {
      return {
        enabled: false,
        preferred_route_id: null,
        tps_floor: model.tpsFloor ?? null,
        max_ttft_ms: model.tpsMaxTtftMs ?? null,
        probe_interval_ms: probeInterval(model),
        probe_budget_per_hour: hourlyProbeBudget(),
        probes_enabled: probesEnabled(),
        window_size: TPS_WINDOW_SIZE,
        demote_count: TPS_DEMOTE_COUNT,
        min_content_tokens: TPS_MIN_CONTENT_TOKENS,
      };
    }
    const state = states.get(route.id);
    const recent = state ? recentSamples(state, now) : [];
    const values = recent.map((sample) => sample.effectiveTps).sort((a, b) => a - b);
    const median = values.length === 0 ? null : values[Math.floor((values.length - 1) / 2)];
    return {
      enabled: true,
      preferred_route_id: route.id,
      tps_floor: Number(model.tpsFloor),
      max_ttft_ms: model.tpsMaxTtftMs ?? null,
      probe_interval_ms: probeInterval(model),
      probe_budget_per_hour: hourlyProbeBudget(),
      probes_enabled: probesEnabled(),
      probes_used_last_hour: probeBudgetUsed(route.id, now),
      degraded: state?.degraded === true,
      effective_tps: median,
      sample_count: recent.length,
      below_floor: recent.filter((sample) => sample.effectiveTps < Number(model.tpsFloor)).length,
      restore_streak: state?.restoreStreak ?? 0,
      last_probe_at: state?.lastProbeAt || null,
      last_probe_tps: state?.lastProbeTps ?? null,
      next_probe_at: state?.degraded ? (state.nextProbeAt || null) : null,
      window_size: TPS_WINDOW_SIZE,
      demote_count: TPS_DEMOTE_COUNT,
      min_content_tokens: TPS_MIN_CONTENT_TOKENS,
    };
  }

  // Returns true when the route is currently demoted by TPS routing.
  function isDegraded(routeId) {
    return states.get(routeId)?.degraded === true;
  }

  // Loads recent valid real-traffic samples for one model's preferred route.
  function hydrateModel(model) {
    if (!enabledFor(model)) return;
    const route = preferredRoute(model);
    if (!route) return;
    const since = Math.max(Date.now() - TPS_STALE_SAMPLE_MS, Number(route.tpsResetAt) || 0);
    const maxTtft = Number(model.tpsMaxTtftMs);
    const gate = Number.isFinite(maxTtft) && maxTtft > 0
      ? 'AND response_ttft_ms IS NOT NULL AND response_ttft_ms <= ?' : '';
    const params = [route.id, since];
    if (gate) params.push(maxTtft);
    params.push(TPS_WINDOW_SIZE);
    let rows;
    try {
      rows = registry.db.prepare(`SELECT ts, effective_tps, response_tps, response_ttft_ms, response_tokens,
          cached_tokens
        FROM telemetry
        WHERE route_id = ? AND is_probe = 0 AND status >= 200 AND status < 400
          AND effective_tps IS NOT NULL AND cached_tokens = 0 AND ts >= ? ${gate}
        ORDER BY id DESC LIMIT ?`).all(...params);
    } catch (error) {
      logger?.warn('tps hydration failed', { routeId: route.id, error: error.message });
      return;
    }
    const state = stateFor(route.id);
    state.samples = rows.reverse().map((row) => ({
      ts: row.ts,
      effectiveTps: row.effective_tps,
      contentTps: row.response_tps,
      contentTtftMs: row.response_ttft_ms,
      contentTokens: row.response_tokens,
      cachedTokens: row.cached_tokens,
    }));
    evaluateDemotion(state, model, Date.now());
  }

  // Loads recent valid real-traffic samples from telemetry after a restart.
  function hydrate() {
    if (!enabledForModelsExist()) return;
    for (const model of registry.modelsById.values()) hydrateModel(model);
  }

  // Returns whether any model currently enables TPS routing.
  function enabledForModelsExist() {
    for (const model of registry.modelsById.values()) {
      if (enabledFor(model)) return true;
    }
    return false;
  }

  // Removes all TPS state for one model.
  function invalidateModel(modelId) {
    for (const [routeId] of states) {
      const route = registry.routeByIdOrNull(routeId);
      if (!route || route.modelId === Number(modelId)) states.delete(routeId);
    }
    schedule();
  }

  // Removes TPS state for one route.
  function invalidateRoute(routeId) {
    states.delete(Number(routeId));
    schedule();
  }

  // Aligns in-memory state with a model's current TPS configuration.
  function syncModel(model) {
    if (!enabledFor(model)) {
      invalidateModel(model.id);
      return;
    }
    for (const [routeId] of states) {
      const route = registry.routeByIdOrNull(routeId);
      if (!route || route.modelId !== model.id || routeId !== model.preferredRouteId) states.delete(routeId);
    }
    const state = stateFor(model.preferredRouteId);
    if (state.samples.length === 0 && !state.degraded) hydrateModel(model);
    reconcileState(state, model);
    if (state.degraded) {
      const base = state.lastProbeAt || Date.now();
      state.nextProbeAt = base + probeInterval(model);
    }
    onStateChange?.(model.id);
    schedule();
  }

  // Clears all state and reloads recent telemetry samples.
  function reload() {
    states.clear();
    hydrate();
    schedule();
  }

  // Runs one probe through the probe runner and applies its outcome to the state machine.
  async function probeRoute(route, model) {
    const outcome = await probe.run(route, model);
    if (outcome.skipped) return false;
    return recordProbeResult(route, model, outcome.valid ? outcome.sample : null, {
      measured: outcome.measured,
    });
  }

  // Applies a probe outcome: three consecutive measured passes at floor x 1.1 restore the route.
  // A probe with no usable measurement (429, timeout, missing usage) is neutral and keeps the streak.
  // Returns true when the probe itself met the restore threshold.
  function recordProbeResult(route, model, sample, { measured = sample !== null } = {}) {
    if (!enabledFor(model) || model.preferredRouteId !== route.id) return false;
    const state = stateFor(route.id);
    state.lastProbeAt = Date.now();
    state.nextProbeAt = state.lastProbeAt + probeInterval(model);
    if (!state.degraded) {
      return isValidTpsSample(sample, { maxTtftMs: model.tpsMaxTtftMs, allowCached: true });
    }
    if (!measured) {
      state.lastProbeTps = null;
      onStateChange?.(model.id);
      return false;
    }
    if (!isValidTpsSample(sample, { maxTtftMs: model.tpsMaxTtftMs, allowCached: true })) {
      // An inconclusive probe (short or truncated output) is not evidence of recovery
      // or of a slow route; keep the existing streak and do not restore.
      state.lastProbeTps = null;
      onStateChange?.(model.id);
      return false;
    }
    state.lastProbeTps = sample.effectiveTps;
    const threshold = Number(model.tpsFloor) * TPS_RESTORE_MULTIPLIER;
    const passed = sample.effectiveTps >= threshold;
    if (passed) {
      state.restoreStreak += 1;
      if (state.restoreStreak >= TPS_RESTORE_STREAK) {
        state.degraded = false;
        state.restoreStreak = 0;
        state.samples = [];
        state.nextProbeAt = 0;
        logger?.info('tps route restored', {
          routeId: route.id, modelId: model.id, tps: sample.effectiveTps,
        });
      }
    } else {
      state.restoreStreak = 0;
    }
    onStateChange?.(model.id);
    schedule();
    return passed;
  }

  // Arms the timer for the nearest due degraded-route probe.
  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (running || stopped || !probesEnabled()) return;
    const now = Date.now();
    let next = null;
    for (const [routeId, state] of states) {
      if (!state.degraded) continue;
      const route = registry.routeByIdOrNull(routeId);
      const model = route ? registry.modelById(route.modelId) : null;
      if (!route || !model || !enabledFor(model) || model.preferredRouteId !== routeId) continue;
      if (!state.nextProbeAt) state.nextProbeAt = now + probeInterval(model);
      if (next === null || state.nextProbeAt < next) next = state.nextProbeAt;
    }
    if (next === null) return;
    timer = setTimeout(() => void tick(), Math.max(0, next - Date.now()));
    timer.unref?.();
  }

  // Probes every degraded preferred route whose interval has elapsed.
  async function tick(now = Date.now()) {
    if (running) return;
    running = true;
    try {
      if (!probesEnabled()) return;
      for (const [routeId, state] of [...states]) {
        if (!state.degraded) continue;
        const route = registry.routeByIdOrNull(routeId);
        const model = route ? registry.modelById(route.modelId) : null;
        if (!route || !model || !enabledFor(model) || model.preferredRouteId !== routeId) continue;
        if ((state.nextProbeAt || Infinity) > now) continue;
        if (!allowProbeBudget(routeId, now)) {
          state.nextProbeAt = now + BUDGET_RETRY_MS;
          continue;
        }
        await probeRoute(route, model);
      }
    } finally {
      running = false;
      schedule();
    }
  }

  // Runs one probe immediately for a route, used by manual controls and tests.
  async function probeNow(routeId) {
    const route = registry.routeByIdOrNull(Number(routeId));
    const model = route ? registry.modelById(route.modelId) : null;
    if (!route || !model || !enabledFor(model) || model.preferredRouteId !== route.id) return false;
    return probeRoute(route, model);
  }

  // Stops the probe timer and aborts any in-flight probe.
  function stop() {
    stopped = true;
    clearTimeout(timer);
    timer = null;
    probe.stop();
  }

  // Starts the probe timer.
  function start() {
    stopped = false;
    schedule();
  }

  hydrate();

  return {
    start,
    stop,
    schedule,
    tick,
    hydrate,
    reload,
    status,
    recordSample,
    recordProbeResult,
    preferredRoute,
    isDegraded,
    invalidateModel,
    invalidateRoute,
    syncModel,
    probeNow,
    enabledFor,
    probesEnabled,
  };
}
