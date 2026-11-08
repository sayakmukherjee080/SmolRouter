# About

SmolOrchestrator is a self-hosted OpenAI-compatible gateway. It runs as one Node.js process, stores state in SQLite, and serves a browser admin UI.

## Design

- No runtime npm dependencies. The server uses Node built-ins.
- One process. Telemetry, probes, health checks, backups, and retention run on in-process timers.
- One SQLite database, using `node:sqlite` with WAL journaling.
- No frontend build step. The admin UI is plain HTML, CSS, and ES modules.
- Telemetry stores request metadata, token counts, timings, costs, and errors. It does not store prompt or completion content.
- Migrations are forward-only and run at startup.
- One gateway instance owns one database file. Multiple writers are not supported.

## Architecture

| Path | Role |
| :--- | :--- |
| `src/server.js` | Configuration, HTTP adapter, security headers, graceful shutdown. |
| `src/gateway/` | Proxy, routing, TPS state and probes, budgets, pricing, FX, cache, telemetry. |
| `src/store/` | Registry, SQLite, migrations runner, mutations, backups, maintenance. |
| `src/admin/` | Admin API, sessions and CSRF, static UI server. |
| `web/` | Admin UI: HTML, CSS, ES modules. |
| `migrations/` | Ordered SQL migrations. |
| `test/` | `node:test` suites, stub upstreams, temporary databases. |
| `docs/` | User and operator documentation. |

The in-memory registry holds the routing state used on every request. SQLite is the durable store. The gateway composes the registry, telemetry writer, metrics, FX, response handler, probe scheduler, and TPS controller.

## Tech stack

- Node.js 22.13 or newer.
- SQLite 3 through `node:sqlite`, WAL journaling, foreign keys enabled.
- Vanilla JavaScript ES modules and hand-written CSS.
- scrypt password verification, signed HttpOnly sessions, CSRF tokens.
- AES-256-GCM provider-key encryption, SHA-256 gateway-key hashes, append-only audit rows.

## Compatibility

| Provider | Notes |
| :--- | :--- |
| OpenAI | Native support. |
| OpenRouter | Supports provider routing and reported costs. |
| Google Gemini | Through OpenAI-compatible endpoints. |
| Vertex AI | With an OpenAI-compatible adapter. |
| Nvidia NIM | Compatible. |
| DeepSeek | Chat and reasoning models, cached-input pricing. |
| Groq, Cerebras | Supported. |

Any other `POST /v1/*` path is routed when the JSON body contains a `model` field.

## Scope

SmolOrchestrator is not a multi-tenant SaaS control plane, a Kubernetes operator, a horizontally scaled cluster, a prompt archive, a model-hosting runtime, or a replacement for provider-side safety and billing systems.

## License

Licensed under the GNU Affero General Public License v3 (AGPL-3.0). See [LICENSE](../LICENSE).
