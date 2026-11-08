// TPS sample validity: content, finish reason, cache, and TTFT gates.
import { TPS_MIN_CONTENT_TOKENS, TPS_COMPLETE_FINISH_REASONS } from '../util/tps_limits.js';

// Returns true when a measured response sample is valid for TPS routing.
// Gateway cache hits never reach this function; provider prompt-cache reads are
// only allowed for probes, where the repeated prompt is expected to be cached.
// A configured TTFT gate requires streaming timing, so buffered JSON samples are excluded.
export function isValidTpsSample(sample, { maxTtftMs = null, allowCached = false } = {}) {
  if (!sample) return false;
  if (!TPS_COMPLETE_FINISH_REASONS.has(sample.finishReason)) return false;
  if (!Number.isFinite(sample.contentTokens) || sample.contentTokens < TPS_MIN_CONTENT_TOKENS) return false;
  if (!Number.isFinite(sample.effectiveTps) || sample.effectiveTps <= 0) return false;
  if (!allowCached && Number(sample.cachedTokens) > 0) return false;
  const ttftLimit = Number(maxTtftMs);
  if (Number.isFinite(ttftLimit) && ttftLimit > 0) {
    if (!Number.isFinite(sample.contentTtftMs) || sample.contentTtftMs > ttftLimit) return false;
  }
  return true;
}
