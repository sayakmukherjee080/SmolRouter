<p align="center">
  <img src="assets/smolorchestrator_logo.png" width="150" alt="SmolOrchestrator Logo">
</p>

> **The Lightweight, Zero-Dependency AI Gateway.**  
> *One key. Many providers. Total control — without the stack.*

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-22.13%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![SQLite](https://img.shields.io/badge/SQLite-3-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![Status](https://img.shields.io/badge/Status-v2.0-success)]()

---

## 🚀 Why SmolOrchestrator?

SmolOrchestrator is a self-hosted AI gateway built for people who want **LiteLLM-style orchestration without the LiteLLM stack**. No Docker, no Postgres, no Redis, no Python, no package managers. One Node process, one SQLite file, one dashboard.

Point any OpenAI-compatible client at your gateway: it sees the models you allow, and everything else — balancing, key rotation, failover, cooldowns, recovery, caching, budgets, and telemetry — happens under the hood.

### ✨ Key Features

*   **Zero Dependencies**: No runtime npm packages. No database server. `node:sqlite` is built in, the rest is standard library.
*   **One Key, Many Models**: Clients authenticate with a gateway key scoped to exactly the models they may use.
*   **Smart Routing**: Priority tiers with `round_robin`, `least_used`, or `cache_aware` balancing per model.
*   **Cache-Aware Stickiness**: Pin each client key to one provider route and exact key so upstream prompt caches keep hitting — reroute only on failure.
*   **Key Pools**: Multiple upstream keys per provider, rotated round-robin; `401`/`403` benches a key automatically.
*   **Failover That Recovers**: Capped exponential backoff on failures, active "ping" probes to bring routes back, and proactive health checks before users see errors.
*   **Two Price Layers**: Upstream route costs (auto-priced from the built-in map or set manually) plus optional downstream prices on the model alias. Admins see both; end users see only the admin-set prices.
*   **Unified Budgets**: Per-token rules for requests, tokens, or amount, across hourly, n-hourly, daily, n-day, weekly, and monthly periods, with per-token timezones, reset times, and exact admission. Optional per-route daily caps remain.
*   **Currency & FX**: Downstream prices and amount budgets in a configurable billing currency, converting upstream USD costs through a cached FX API.
*   **LiteLLM-Compatible Surfaces**: `/model/info`, `/key/info`, and `x-litellm-*` headers for pricing, spend, and budget visibility.
*   **Response Cache + Singleflight**: Deterministic (`temperature: 0`) requests are cached and concurrent duplicates collapse into one upstream call.
*   **Prompt-Cache Savings**: Provider cached-token counts are parsed and priced, so the dashboard shows what caching actually saved you.
*   **Capability-Aware Routing**: Routes declare `tools`, `vision`, `audio`, `json`, `reasoning`, and max context; incompatible routes are skipped before you waste a request.
*   **Transparent Proxy**: Byte-for-byte passthrough, streaming included. The only request mutations are the upstream model name and usage-tracking options.
*   **Observability Without Content**: Attempt-level telemetry, per-day usage, latency percentiles, and Prometheus metrics — prompts and completions are never stored.
*   **Modern Admin UI**: Light/dark, minimal, micro-animated. No CDN assets, no build step.
*   **Backups & Config Transfer**: Scheduled SQLite snapshots plus JSON config export/import for moving between boxes.

---

## 🛠️ Tech Stack

*   **Backend**: Node.js 22.13+ (pure functionality, no web framework)
*   **Database**: SQLite 3 via `node:sqlite` (portable, zero-config, WAL)
*   **Frontend**: Vanilla JS (ES modules) + hand-rolled CSS design tokens (light/dark)
*   **Security**: scrypt passwords, signed HttpOnly sessions, CSRF tokens, AES-256-GCM encrypted provider keys, audit trail.

### Requirements

*   Node.js **22.13 or newer** (needed for `node:sqlite`).
*   Nothing else. No Postgres, Redis, Docker, or Python. No cron daemon required — background jobs run in-process.
*   The original PHP implementation lives under [`legacy/`](legacy/) for reference.

---

## 🕰️ Background Jobs (Built In)

There is no worker script to schedule. The process owns its own timers:

*   telemetry flush to SQLite every `TELEMETRY_FLUSH_MS`,
*   recovery probes for cooling routes,
*   proactive health checks on `HEALTH_CHECK_INTERVAL_MS`,
*   scheduled backups on `BACKUP_INTERVAL_MS`,
*   graceful shutdown (drain, flush, close) on `SIGTERM`/`SIGINT`.

---

## 🔌 Compatibility

SmolOrchestrator is a transparent proxy; any provider that speaks the OpenAI API works.

| Provider | Status | Notes |
| :--- | :---: | :--- |
| **OpenAI** | ✅ | Native support. |
| **OpenRouter** | ✅ | Works perfectly. |
| **Google Gemini** | ✅ | Via their OpenAI-compatible endpoints. |
| **Vertex AI** | ✅ | Works with an OpenAI-compatible adapter. |
| **Nvidia NIM** | ✅ | Fully compatible. |
| **DeepSeek** | ✅ | Chat and reasoner models, cache-aware pricing. |
| **Groq / Cerebras** | ✅ | Fast inference supported. |

Any other `POST /v1/*` endpoint is routed too, as long as the JSON body carries a `model` field.

---

## 🎨 Visuals & Animations

The dashboard went from cyber-terminal to **calm and modern**:

*   **Light & Dark Modes**: System-aware with a one-click toggle, remembered per browser.
*   **Micro-Animations**: Hover lifts, fading modals, skeleton loaders, animated badges — all CSS, all respecting `prefers-reduced-motion`.
*   **No CDN, No Build**: The UI is plain HTML, CSS, and ES modules shipped with the server.

---

## 📦 Installation

SmolOrchestrator runs anywhere Node runs: a $5 VPS, a home server, a container, or your laptop.

1.  **Install and Configure**
    ```bash
    npm run setup
    ```
    The installer runs `npm install`, prompts for your admin email and password, generates the
    application secret, writes `.env`, creates `storage/gateway.db`, applies migrations, and drops
    the install lock.

2.  **Start**
    ```bash
    npm start
    ```
    Default listener: `http://127.0.0.1:8787`. Admin UI: `/admin`.

3.  **Expose It** (optional)
    Put any reverse proxy or tunnel in front — for example a Cloudflare quick tunnel:
    ```bash
    cloudflared tunnel --url http://127.0.0.1:8787
    ```
    The tunnel is external infrastructure; the gateway itself needs no Cloudflare configuration.
    When using it, set `TRUST_PROXY=true` in `.env` so client IPs come from `CF-Connecting-IP`.

---

## ⚡ Usage

Once installed, SmolOrchestrator exposes an OpenAI-compatible API.

### Endpoint Configuration

Point any OpenAI-compatible client (OpenCode, LangChain, Chatbox, etc.) at your gateway.

*   **Base URL**: `https://your-host/v1`
*   **Chat Completions**: `/v1/chat/completions`
*   **Models**: `/v1/models` returns only the models your key is scoped to.

### Example Request

```bash
curl https://your-host/v1/chat/completions \
  -H "Authorization: Bearer YOUR_GATEWAY_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "ds-v4.1-flash",
    "messages": [
      {
        "role": "user",
        "content": "Hello via SmolOrchestrator!"
      }
    ],
    "stream": true
  }'
```

Responses carry helpful headers: `X-Smolorchestrator-Provider`, `X-Cache` (`hit`/`miss`/`coalesced`), `X-Request-Cost` / `X-LiteLLM-Response-Cost` when the response body is captured (non-streaming JSON under `NONSTREAM_CAPTURE_MAX_BYTES`), `X-Budget-Remaining` / `X-Budget-Rules` / `X-Budget-Warning`, and LiteLLM-compatible `X-LiteLLM-Key-Spend`, `X-LiteLLM-Key-Max-Budget`, `X-LiteLLM-Key-Remaining-Budget`, `X-LiteLLM-Key-Budget-Duration`, and `X-LiteLLM-Key-Budget-Reset-At` headers for metered keys. Streaming responses cannot emit a final cost header; use `/key/info` or the completion's `usage` object.

### Admin Dashboard

Login at `/admin` to:

*   Manage **Providers** — OpenAI-compatible endpoints with rotating key pools; add/toggle/delete keys and verify reachability.
*   Create **Models** (e.g., `ds-v4.1-flash`) and attach provider routes with upstream model IDs, per-million prices, capability flags, context limits, and optional daily caps. Set optional downstream prices per model; blank means pass-through.
*   Generate **Gateway Keys**, scope them to models, choose a timezone, and add request, token, or amount rules across hourly through monthly periods.
*   Watch **Usage** — requests, tokens, cached-token savings, upstream estimated/provider-reported spend, downstream billed, margin, response-cache hit rate, and p50/p95 latency.
*   Read **Logs** — attempt-level telemetry with zero content capture.
*   Tune **Settings** — routing/probes, gateway limits (attempts, timeouts, key policy, body caps), security (proxy trust, rate limits, login lockout, session TTL, metrics token, **password rotation**), cache caps, retention, budgets, backups, and config transfer. Runtime knobs apply instantly; timer intervals are labelled "restart".

---

### Pricing, budgets, and currency

- **Upstream layer** — each route has input/output USD prices per million tokens. Leave them blank to use the built-in price map; explicit values override it. Providers that report `usage.cost` (for example OpenRouter) have the actual cost stored as `upstream_cost` for analytics.
- **Downstream layer** — optional input/output/cached-input prices on the model alias, tagged with the `BILLING_CURRENCY` active when they were saved. Blank means pass-through to the route cost converted from USD. Downstream prices can be set even when the upstream is free.
- **Budgets** — per gateway key, add rules by metric (`requests`, `tokens_in`, `tokens_out`, `tokens_total`, `amount`) and period (`hour`, every N hours, `day`, every N days, `week`, `month`). Each rule carries a timezone, reset time, and anchor. Rule windows longer than `TOKEN_USAGE_RETENTION_DAYS` are rejected so counters can always be rebuilt. Reservations are synchronous and exact; failed or aborted requests release their reservation. Cache hits count as requests and consume cached tokens/amount. When a request omits `max_tokens`, token/amount reservations cover the input estimate only; output is reconciled after the response, so concurrent requests can exceed those caps by in-flight output. Specify `max_tokens` when a hard cap must be exact.
- **Currency** — set `BILLING_CURRENCY` in the environment and Settings. Upstream USD costs are converted through `FX_API_URL` (default Frankfurter) with a cached, single-flight rate; `FX_API_KEY` is optional and `FX_MAX_STALE_MS` bounds fallback after refresh failures. Amount rules and downstream prices are tagged with their currency. Changing the currency while model prices, amount rules, or monetary usage exist requires `convertCurrency: true` in the settings request; conversion blocks new gateway admissions, drains in-flight requests up to `CURRENCY_CHANGE_DRAIN_MS`, flushes billing telemetry, and updates prices, limits, and current billing events in one transaction. Historical usage rows keep their original currency and rate; margin is reported as unavailable when a legacy non-USD row has no stored FX rate. Pre-feature spend caps were USD; when the active currency is not USD, Settings flags legacy amount rules and events for review.
- **LiteLLM-compatible surface** — `GET /model/info` (client-facing downstream prices, including cached-input price and route-dependent ranges) and `GET /key/info` (total amount-rule spend, budget reset, rules) authenticate with the gateway key. Admins see both layers at `/api/v1/model-info` and per-token rules at `/api/v1/tokens/:id`. The implemented subset intentionally omits `tpm_limit`, `rpm_limit`, `soft_budget`, and `max_parallel_requests`; `max_output_tokens` is reported as `null` until an explicit output limit exists.
- **OpenCode** reads model costs from models.dev or a custom provider `cost` block, not from the gateway's `/model/info`; use the gateway dashboard or `/key/info` for quota visibility.
- **Privacy** — analytics store request/token/cost metadata only. There is no column, log, or API for prompt or completion content. The optional response cache is the sole transient content store: response bodies live in memory only and caching is per-model opt-out.
- **Upgrade note** — migration 007 backfills per-request billing events from retained telemetry, and migration 009 restores spend history for legacy amount caps from the upstream estimated cost those caps originally enforced. Pre-unification cache-hit consumption is not recoverable per token, and budget windows older than telemetry retention are only partially backfilled.

## 🔭 Operations

*   `GET /health` — liveness.
*   `GET /health/ready` — readiness (database reachable).
*   `GET /metrics` — Prometheus text metrics; set `METRICS_TOKEN` to require a bearer token.
*   Backups are plain SQLite snapshots (`BACKUP_*` settings) created on schedule or on demand.
*   Retention maintenance prunes telemetry and usage on schedule (`TELEMETRY_RETENTION_DAYS`,
    `USAGE_RETENTION_DAYS`; `0` keeps telemetry forever, usage is floored at 32 days so the current
    month always survives). `TOKEN_USAGE_RETENTION_DAYS` bounds per-request billing events, and
    pruning never removes events still inside an active budget window. Audit rows are never pruned.
*   **Migration rollback** — migrations are forward-only. Stop the gateway, then restore a verified
    snapshot with `npm run db:restore -- storage/backups/<backup>.db --yes`. The tool validates the
    snapshot, writes a `pre-restore` safety copy of the current database, and verifies the restored
    file. Timestamped `backup_*_remediation` tables remain available inside the database for
    row-level recovery.
*   Behind a reverse proxy or tunnel set `TRUST_PROXY=true` so rate limiting and login lockouts key
    off `CF-Connecting-IP` / `X-Forwarded-For`.
*   Every configuration variable is documented in [`.env.example`](.env.example).

### Restoring a backup

1. Stop the gateway (Ctrl+C in its terminal, or kill the listener on the port).
2. Copy the snapshot over the live database and remove any sidecar journal files:
   ```bash
   cp storage/backups/gateway-YYYYMMDDHHMMSS.db storage/gateway.db
   rm -f storage/gateway.db-wal storage/gateway.db-shm
   ```
3. Start the gateway again: `npm start`.

For partial migrations between boxes, prefer the config export/import cards in the dashboard.

---

## 📚 API Documentation

The Postman collection at [`postman/smolorchestrator.postman_collection.json`](postman/smolorchestrator.postman_collection.json) documents every gateway and admin endpoint, including request/response shapes and the CSRF flow.

## 🧪 Testing

```bash
npm test
```

Covers migrations, authentication and model scoping, balancing strategies, cache-aware pinning, failover and cooldowns, Retry-After cooldowns, key-retry caps, probes and health checks, response cache and singleflight, usage extraction (streaming, non-streaming, estimation), bounded non-stream capture, cached-token and provider-reported cost, unified budget rules and timezone windows, guarded currency conversion with in-flight draining and per-currency analytics, counter inheritance across rule edits, guarded config-bundle currency metadata, downstream pricing and LiteLLM endpoints, FX single-flight and staleness, cache-hit durability, rule-replacement reservations, client-disconnect telemetry, retention maintenance, backups and backup restore, config import/export, admin API security, no-content schema checks, and the hot-path selection budget.

---

## 📜 License

This project is open-sourced software licensed under the **GNU Affero General Public License v3 (AGPL-3.0)**. See [LICENSE](LICENSE) for details.
