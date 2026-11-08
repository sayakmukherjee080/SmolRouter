# API Reference

The Postman collection is the canonical reference for request and response shapes:

[`postman/smolorchestrator.postman_collection.json`](../postman/smolorchestrator.postman_collection.json)

## Versions and envelopes

- Admin API: `/api/v1/...`
- Gateway API: `/v1/...` (OpenAI-compatible)

Admin success:

```json
{ "success": true, "data": {} }
```

Admin error:

```json
{
  "success": false,
  "error": "Human-readable message",
  "code": "MACHINE_READABLE",
  "details": {}
}
```

Gateway error:

```json
{
  "error": {
    "message": "Human-readable message",
    "type": "invalid_request_error",
    "code": "model_not_found"
  }
}
```

`details` is optional and field-level.

## Gateway endpoints

| Method | Path | Purpose |
| :--- | :--- | :--- |
| `GET` | `/v1/models` | Models allowed by the gateway key. |
| `POST` | `/v1/chat/completions` | Chat completion, streaming or buffered. |
| `POST` | `/v1/*` | Other JSON paths with a `model` field. |
| `GET` | `/model/info` | Client-facing downstream prices and route ranges. |
| `GET` | `/key/info` | Key spend, budget reset, and amount rules. |
| `GET` | `/health` | Liveness. |
| `GET` | `/health/ready` | Readiness. |
| `GET` | `/metrics` | Prometheus metrics. |

Gateway authentication uses `Authorization: Bearer <gateway-key>`. Keys are scoped to models.

## Admin endpoints

All admin routes except login require a session cookie. Mutating routes also require `X-CSRF-Token`.

### Session

| Method | Path |
| :--- | :--- |
| `POST` | `/api/v1/session` |
| `GET` | `/api/v1/session` |
| `DELETE` | `/api/v1/session` |
| `PUT` | `/api/v1/session/password` |

### Models and TPS

| Method | Path |
| :--- | :--- |
| `GET` | `/api/v1/models` |
| `POST` | `/api/v1/models` |
| `PATCH` | `/api/v1/models/:id` |
| `DELETE` | `/api/v1/models/:id` |
| `GET` | `/api/v1/models/:id/routes` |
| `POST` | `/api/v1/models/:id/routes` |
| `PATCH` | `/api/v1/routes/:id` |
| `DELETE` | `/api/v1/routes/:id` |
| `POST` | `/api/v1/models/:id/tps/probe` |

Model `PATCH` accepts `tpsFloor`, `preferredRouteId`, `tpsProbeIntervalMs`, and `tpsMaxTtftMs`. See [TPS-aware routing](tps-routing.md).

### Providers and keys

| Method | Path |
| :--- | :--- |
| `GET` | `/api/v1/providers` |
| `POST` | `/api/v1/providers` |
| `PATCH` | `/api/v1/providers/:id` |
| `DELETE` | `/api/v1/providers/:id` |
| `GET` | `/api/v1/providers/:id/upstream-models` |
| `POST` | `/api/v1/providers/:id/keys` |
| `PATCH` | `/api/v1/keys/:id` |
| `DELETE` | `/api/v1/keys/:id` |

### Tokens and budgets

| Method | Path |
| :--- | :--- |
| `GET` | `/api/v1/tokens` |
| `POST` | `/api/v1/tokens` |
| `GET` | `/api/v1/tokens/:id` |
| `PATCH` | `/api/v1/tokens/:id` |
| `DELETE` | `/api/v1/tokens/:id` |
| `PUT` | `/api/v1/tokens/:id/models` |

### Usage, telemetry, settings, cache

| Method | Path |
| :--- | :--- |
| `GET` | `/api/v1/usage` |
| `GET` | `/api/v1/telemetry` |
| `GET` | `/api/v1/model-info` |
| `GET` | `/api/v1/settings` |
| `PUT` | `/api/v1/settings` |
| `POST` | `/api/v1/cache/flush` |

`GET /api/v1/usage` returns `usage`, `currencySummary`, `cacheStats`, `latency`, and `tps`.

### Backups and config transfer

| Method | Path |
| :--- | :--- |
| `GET` | `/api/v1/backups` |
| `POST` | `/api/v1/backups` |
| `GET` | `/api/v1/config/export` |
| `POST` | `/api/v1/config/import` |

## Authentication and CSRF

1. `POST /api/v1/session` with email and password.
2. The response sets an HttpOnly session cookie and returns `data.csrf`.
3. Send the cookie on admin requests.
4. Send `X-CSRF-Token: <csrf>` on mutating requests.

## Limits

- `/api/v1/telemetry` accepts `limit` and `offset`; limit is capped at 500.
- Request bodies are capped by `MAX_BODY_BYTES`.
- `/api/v1/usage` accepts `entity` and `windowStart`.
- Gateway IP rate limiting uses `IP_RATE_LIMIT` and `IP_RATE_WINDOW_MS`.

## Documentation maintenance

When an endpoint or shape changes, update the Postman collection, this page when the route is listed, the relevant guide in `/docs`, and `CHANGELOG.md`.
