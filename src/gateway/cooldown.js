// Provider route cooldown state: capped exponential backoff and recovery.
const MAX_RETRY_AFTER_MS = 86400000;

// Returns true while a route is inside its cooldown window.
export function isCooling(route, now) {
  return route.cooldownUntil > now;
}

// Advances a route's failure count and schedules capped exponential backoff.
export function applyFailure(route, { now, baseMs, capMs, retryAfterMs = 0 }) {
  route.consecutiveFailures += 1;
  const backoff = Math.min(capMs, baseMs * 2 ** (route.consecutiveFailures - 1));
  const providerDelay = Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) : 0;
  const delay = Math.min(MAX_RETRY_AFTER_MS, Math.max(backoff, providerDelay));
  route.cooldownUntil = now + delay;
  return delay;
}

// Clears failure state after a successful request or probe.
export function applySuccess(route, now) {
  route.consecutiveFailures = 0;
  route.cooldownUntil = 0;
  route.lastProbeAt = now;
}
