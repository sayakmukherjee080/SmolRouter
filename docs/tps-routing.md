# TPS-Aware Routing

TPS-aware routing keeps a preferred route while its effective TPS stays above a per-model floor. When it degrades, traffic moves to another route. A background probe restores the preferred route after recovery.

TPS mode is off until a preferred route and a floor are configured. It works with the existing priority tiers and `round_robin`, `least_used`, and `cache_aware` strategies.

## Configuration

Configure per model in Models → TPS, or through the admin API:

```http
PATCH /api/v1/models/42
Content-Type: application/json
Cookie: <session>
X-CSRF-Token: <csrf>
```

```json
{
  "tpsFloor": 60,
  "preferredRouteId": 7,
  "tpsProbeIntervalMs": 300000,
  "tpsMaxTtftMs": 8000
}
```

| Field | Meaning |
| :--- | :--- |
| `tpsFloor` | Positive effective tokens/second, or `null`. Required for TPS mode. |
| `preferredRouteId` | Active route belonging to the model, or `null`. Required for TPS mode. |
| `tpsProbeIntervalMs` | Probe interval from 60,000 to 1,800,000 ms, or `null` for the global default (300,000 ms). |
| `tpsMaxTtftMs` | Optional maximum content TTFT in milliseconds. `null` or `0` disables the gate. |

Global defaults:

```env
TPS_PROBE_INTERVAL_MS=300000
TPS_PROBE_TIMEOUT_MS=180000
TPS_PROBE_MAX_TOKENS=3000
TPS_PROBE_PROMPT=Write complete Python code ...
```

The per-model interval overrides `TPS_PROBE_INTERVAL_MS`.

## Metric

The routing metric is effective content TPS:

```text
effective_tps = response_content_tokens / (last_content_delta - request_start)
```

Secondary metric:

```text
content_tps = response_content_tokens / (last_content_delta - first_content_delta)
```

`response_content_tokens` is `completion_tokens - reasoning_tokens`. Reasoning-only and truncated responses are excluded.

Content TTFT is recorded as `first_content_delta - request_start`. When `tpsMaxTtftMs` is set, samples above the limit are rejected.

## Valid samples

A sample enters the routing window only when:

- upstream usage is present, not byte-estimated,
- the finish reason is `stop`, `end_turn`, `stop_sequence`, or `eos`,
- response content is at least 100 tokens,
- effective TPS is positive,
- the response was not served by the gateway response cache,
- provider-cache reads (`cached_tokens > 0`) are excluded for user traffic,
- if `tpsMaxTtftMs` is set, content TTFT is present and within the limit.

Streaming responses without usage cannot produce a sample. The probe retries non-streaming when usage is missing.

## Demotion

The preferred route keeps the last 12 valid real-traffic samples. Samples older than 10 minutes are ignored.

The route is demoted when 10 of the last 12 samples are below `tpsFloor`.

On demotion:

- new traffic uses the next available route under the model's normal priority and strategy rules,
- cache-aware pins are cleared and bypassed while TPS routing is active,
- a recovery probe is scheduled after the model's probe interval,
- if no fallback route is available, the degraded preferred route is used instead of returning `502`.

## Fallback

Fallback uses existing priority tiers and the model strategy. It does not use a separate balancing order.

For `cache_aware` models, TPS mode bypasses pins entirely. When TPS mode is disabled, normal pinning resumes.

## Probes

While the preferred route is degraded, a worker sends one coding probe per route. It:

- runs only when `probe_enabled` is true,
- respects the per-route `probe_budget_per_hour` setting,
- allows one probe in flight per route,
- uses the provider key pool directly and does not consume gateway token budgets,
- marks telemetry with `is_probe = 1`, excluded from user usage and TPS samples,
- aborts in-flight probes during shutdown.

Probe request order:

1. Stream with `stream_options.include_usage`.
2. If streaming returns no usage, retry as non-streaming JSON.
3. If a complete response is under 100 content tokens, retry once with a larger token budget, up to 8,000.

A manual probe is available:

```http
POST /api/v1/models/42/tps/probe
Cookie: <session>
X-CSRF-Token: <csrf>
```

Manual probes bypass `probe_enabled` and the hourly budget. The response contains `{ probed, passed, tps }`.

## Restoration

The preferred route is restored after three measured probe passes at `tpsFloor × 1.1`.

- A valid sample below the threshold resets the streak.
- An inconclusive probe keeps the streak but does not restore. This includes missing usage, short or truncated output, timeout, and `429`.
- `401` and `403` disable the provider key. `429` and timeouts do not.
- After restoration, the sample window is cleared and traffic returns to the preferred route.

## Restart and repointing

TPS state is held in memory and hydrated from recent telemetry on startup and when TPS is enabled.

Each route has `tps_reset_at`. Changing a route's provider or upstream model, or changing a provider's base URL, resets TPS history. Old samples cannot demote the new target.

On restart, recent valid samples are loaded. If 10 of the last 12 are below the floor, the route starts degraded and probes begin.

If the preferred route is deleted or its provider is removed, the model preference is cleared.

## Status and history

`GET /api/v1/models` includes a `tps` object per model:

```json
{
  "enabled": true,
  "preferred_route_id": 7,
  "tps_floor": 60,
  "max_ttft_ms": 8000,
  "probe_interval_ms": 300000,
  "probe_budget_per_hour": 12,
  "probes_enabled": true,
  "probes_used_last_hour": 0,
  "degraded": false,
  "effective_tps": 72.4,
  "sample_count": 12,
  "below_floor": 1,
  "restore_streak": 0
}
```

The Usage page includes a 24-hour TPS table with effective TPS, content TPS, TTFT, and sample count per route.

## Notes

- Set the floor per model and provider. TPS varies by workload, model, and provider.
- Effective TPS includes time to first content, so it reflects user-perceived speed better than generation-only TPS.
- Provider prompt-cache reads are excluded for user samples but allowed for probes, because the probe prompt is repeated.
- If a TTFT gate is set, non-streaming samples are excluded because they have no TTFT measurement.
- `probe_budget_per_hour` applies separately to health probes and TPS probes.
- TPS telemetry stores token counts, timings, and rates only.
