// Usage and response timing extraction from upstream responses without retaining content.
const MAX_SSE_REMAINDER = 262144;

// Rounds a floating-point rate to milliths for stable telemetry values.
function roundRate(value) {
  return Math.round(value * 1000) / 1000;
}

// Reads token counts from an OpenAI-style usage object, including reasoning and provider cache hits.
function readUsageObject(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = usage.prompt_tokens ?? usage.input_tokens;
  const output = usage.completion_tokens ?? usage.output_tokens;
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null;
  const cached = usage.prompt_tokens_details?.cached_tokens
    ?? usage.prompt_cache_hit_tokens
    ?? usage.cache_read_input_tokens
    ?? 0;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
    ?? usage.output_tokens_details?.reasoning_tokens
    ?? 0;
  const upstreamCost = Number(usage.cost);
  return {
    inputTokens: Number.isFinite(input) ? input : 0,
    outputTokens: Number.isFinite(output) ? output : 0,
    cachedTokens: Number.isFinite(cached) ? cached : 0,
    reasoningTokens: Number.isFinite(reasoning) ? reasoning : 0,
    upstreamCost: Number.isFinite(upstreamCost) ? upstreamCost : null,
  };
}

// Returns true when a streaming content delta contains usable text.
function hasContentText(value) {
  if (typeof value === 'string') return value.length > 0;
  if (!Array.isArray(value)) return false;
  return value.some((part) => typeof part?.text === 'string' && part.text.length > 0);
}

// Creates an incremental usage and content-timing extractor for SSE or buffered JSON responses.
export function createUsageExtractor({ mode, maxBytes, startedPerf = null }) {
  let remainder = '';
  let jsonBuffer = '';
  let jsonOverflow = false;
  let usage = null;
  let finishReason = null;
  let totalBytes = 0;
  let firstContentAt = null;
  let lastContentAt = null;
  let completedAt = null;

  // Records content timing and finish reason from one parsed SSE payload.
  function noteDelta(parsed, at) {
    const choice = parsed?.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (!delta) return;
    if (!hasContentText(delta.content)) return;
    if (firstContentAt === null) firstContentAt = at;
    lastContentAt = at;
  }

  // Scans one complete SSE data line for usage, content timing, or a finish reason.
  function scanLine(line, at) {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    if (!payload.includes('"usage"') && !payload.includes('"delta"') && !payload.includes('"finish_reason"')) return;
    try {
      const parsed = JSON.parse(payload);
      if (parsed.usage) usage = readUsageObject(parsed.usage) ?? usage;
      noteDelta(parsed, at);
    } catch {
      // Ignore non-JSON data lines.
    }
  }

  return {
    // Feeds a response chunk into the extractor.
    push(chunk) {
      totalBytes += chunk.length;
      if (mode === 'sse') {
        const at = performance.now();
        remainder += chunk.toString('utf8');
        const lines = remainder.split('\n');
        remainder = lines.pop() ?? '';
        for (const line of lines) scanLine(line.replace(/\r$/, ''), at);
        if (remainder.length > MAX_SSE_REMAINDER) remainder = remainder.slice(-MAX_SSE_REMAINDER);
      } else if (mode === 'json' && !jsonOverflow) {
        if (totalBytes <= maxBytes) {
          jsonBuffer += chunk.toString('utf8');
        } else {
          jsonOverflow = true;
          jsonBuffer = '';
        }
      }
    },
    // Returns observed token counts, content timing, and derived throughput, or null.
    result() {
      if (completedAt === null) completedAt = performance.now();
      let observed = null;
      if (mode === 'sse') {
        observed = usage;
      } else if (mode === 'json' && !jsonOverflow) {
        try {
          const parsed = JSON.parse(jsonBuffer);
          observed = readUsageObject(parsed?.usage);
          if (parsed?.choices?.[0]?.finish_reason) finishReason = parsed.choices[0].finish_reason;
        } catch {
          observed = null;
        }
      }
      if (!observed) return null;
      const contentTokens = Math.max(0, observed.outputTokens - observed.reasoningTokens);
      const start = Number.isFinite(startedPerf) ? startedPerf : null;
      let contentTtftMs = null;
      let contentGenerationMs = null;
      let contentTps = null;
      let effectiveTps = null;
      if (firstContentAt !== null && lastContentAt !== null) {
        contentGenerationMs = Math.max(0, Math.round(lastContentAt - firstContentAt));
        if (start !== null) contentTtftMs = Math.max(0, Math.round(firstContentAt - start));
        if (contentGenerationMs > 0) contentTps = roundRate(contentTokens / (contentGenerationMs / 1000));
        const wallMs = start === null ? null : lastContentAt - start;
        if (wallMs && wallMs > 0) effectiveTps = roundRate(contentTokens / (wallMs / 1000));
      } else if (start !== null) {
        const wallMs = completedAt - start;
        if (wallMs > 0) effectiveTps = roundRate(contentTokens / (wallMs / 1000));
      }
      return {
        ...observed,
        finishReason,
        contentTokens,
        contentTtftMs,
        contentGenerationMs,
        contentTps,
        effectiveTps,
      };
    },
    // Returns the total bytes observed on the response body.
    bytes() {
      return totalBytes;
    },
  };
}

// Estimates tokens from a byte count (documented fallback only).
export function estimateTokens(bytes) {
  return Math.ceil(bytes / 4);
}
