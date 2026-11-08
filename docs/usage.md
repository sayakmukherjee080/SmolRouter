# Usage

SmolRouter exposes an OpenAI-compatible API. Clients authenticate with a gateway key scoped to specific model aliases.

## Client configuration

- Base URL: `https://your-host/v1`
- Chat completions: `POST /v1/chat/completions`
- Models: `GET /v1/models` returns only models allowed by the key.
- Other JSON paths: any `POST /v1/*` path with a `model` field is routed through the gateway.

```bash
curl https://your-host/v1/chat/completions \
  -H "Authorization: Bearer YOUR_GATEWAY_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "ds-v4.1-flash",
    "messages": [
      { "role": "user", "content": "Hello via SmolRouter." }
    ],
    "stream": true
  }'
```

`ds-v4.1-flash` is an alias created in the admin UI. The gateway rewrites the upstream model name and injects usage-tracking options; the rest of the request passes through.

## Response headers

Headers are present when the data is available:

- `X-SmolRouter-Provider`: upstream provider name.
- `X-Cache`: `hit`, `miss`, `coalesced`, or `bypass`.
- `X-Request-Cost`, `X-LiteLLM-Response-Cost`: downstream cost for captured non-streaming JSON responses.
- `X-Budget-Remaining`, `X-Budget-Rules`, `X-Budget-Warning`: budget status for metered keys.
- `X-LiteLLM-Key-Spend`, `X-LiteLLM-Key-Max-Budget`, `X-LiteLLM-Key-Remaining-Budget`,
  `X-LiteLLM-Key-Budget-Duration`, `X-LiteLLM-Key-Budget-Reset-At`: LiteLLM-compatible spend metadata.

Streaming responses cannot send a final cost header. Use `/key/info`, the completion's `usage` object, or the dashboard.

## Admin UI

Login at `/admin`.

- Providers: OpenAI-compatible endpoints, key pools, reachability checks.
- Models: aliases, provider routes, prices, capabilities, context limits, daily caps, downstream prices, TPS routing.
- Tokens: gateway keys, model scopes, timezones, request/token/amount budget rules.
- Usage: requests, tokens, cached tokens, spend, margin, cache hit rate, latency, TPS.
- Logs: attempt telemetry without content.
- Settings: routing, probes, limits, security, cache, retention, backups, config transfer.

See [TPS-aware routing](tps-routing.md) for preferred-route and probe controls.

## Errors

Gateway errors use the OpenAI error shape:

```json
{
  "error": {
    "message": "The model 'example' does not exist",
    "type": "invalid_request_error",
    "code": "model_not_found"
  }
}
```

Common statuses:

- `400`: malformed body, missing `model`, unsupported capability, or invalid parameter.
- `401`: missing or invalid gateway key.
- `404`: unknown model or no access to the model.
- `413`: body above `MAX_BODY_BYTES`.
- `429`: IP rate limit, budget exhaustion, route quota exhaustion, or upstream rate limiting.
- `499`: client closed the request.
- `502`: every eligible upstream attempt failed.

## Routing

A model alias is what clients request. Each route maps the alias to a provider, an upstream model ID, a priority tier, and optional pricing or capability metadata.

For each request:

1. Routes that fail capabilities, context limits, cooldown, quota, or key availability are removed.
2. The lowest available priority tier is selected.
3. The model strategy chooses within that tier: `round_robin`, `least_used`, or cache-aware pinning.
4. If TPS-aware routing is enabled, the preferred route is tried first. Fallback uses the same tier and strategy rules.

## Streaming

Streaming and non-streaming requests are supported. For streaming requests, the gateway adds `stream_options.include_usage` when it is missing. If a provider ignores usage in streaming, billing falls back to byte estimates and TPS sampling may be unavailable for that route.

## Privacy

The gateway does not store prompts or completions in telemetry, logs, or APIs. The optional response cache is the only transient content store. Cached bodies live in memory and caching can be disabled per model.
