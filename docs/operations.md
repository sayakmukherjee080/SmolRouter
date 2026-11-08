# Operations

The gateway is a single Node process with in-process timers.

## Health and metrics

- `GET /health`: liveness; returns `200` while the process is up.
- `GET /health/ready`: readiness; returns `503` when the database is unavailable.
- `GET /metrics`: Prometheus text metrics. Set `METRICS_TOKEN` to require `Authorization: Bearer <token>`.

## Background jobs

- Telemetry flush every `TELEMETRY_FLUSH_MS`.
- Recovery probes for cooling routes.
- TPS recovery probes for degraded preferred routes.
- Proactive health checks on `HEALTH_CHECK_INTERVAL_MS`.
- Scheduled backups on `BACKUP_INTERVAL_MS`.
- Retention maintenance on `MAINTENANCE_INTERVAL_MS`.
- FX rate caching and single-flight on demand.
- Graceful shutdown on `SIGTERM` or `SIGINT`.

Runtime settings apply immediately unless the setting is marked as requiring a restart.

## Shutdown

On `SIGTERM` or `SIGINT` the process:

1. stops accepting connections,
2. drains in-flight requests for up to `SHUTDOWN_DRAIN_MS`,
3. stops probe and TPS timers,
4. aborts in-flight TPS probes,
5. flushes telemetry,
6. closes SQLite and exits.

## Backups

Backups are SQLite snapshots created with `VACUUM INTO`.

- Configure with `BACKUP_ENABLED`, `BACKUP_INTERVAL_MS`, `BACKUP_KEEP`, and `BACKUP_PATH`.
- Create one on demand from the dashboard.
- Snapshots contain encrypted provider keys. Protect them like the live database.

Restore:

```bash
npm run db:restore -- storage/backups/<backup>.db --yes
```

The restore tool validates the snapshot, writes a `pre-restore` safety copy, replaces the database atomically, and verifies the restored file.

Migrations are forward-only. Stop the gateway before restoring. Timestamped `backup_*_remediation` tables remain in the database for row-level recovery.

## Retention

- `TELEMETRY_RETENTION_DAYS`: attempt telemetry. `0` keeps telemetry forever.
- `USAGE_RETENTION_DAYS`: aggregate usage. Floored at 32 days so the current month survives.
- `TOKEN_USAGE_RETENTION_DAYS`: per-request billing events used to rebuild budget windows.
- Audit rows are never pruned.
- Events inside an active budget window are never removed.

## Reverse proxy

When exposing the gateway beyond localhost, put a reverse proxy or tunnel in front of it.

Set:

```env
TRUST_PROXY=true
```

so rate limiting and login lockouts use `CF-Connecting-IP` or `X-Forwarded-For`. Do not enable it when clients can spoof those headers.

Enforce HTTPS at the proxy. The gateway does not terminate TLS.

## Configuration

All environment variables are documented in [`.env.example`](../.env.example).

- Server: `HOST`, `PORT`, `TRUST_PROXY`.
- Security: `APP_SECRET`, `COOKIE_SECURE`, `SESSION_TTL_MS`, `LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCKOUT_MS`, `IP_RATE_LIMIT`, `IP_RATE_WINDOW_MS`, `MAX_BODY_BYTES`.
- Gateway: `IDLE_TIMEOUT_MS`, `MAX_ATTEMPTS`, `KEY_DISABLE_MS`, `BACKOFF_BASE_MS`, `BACKOFF_CAP_MS`, `KEY_RETRIES_PER_ROUTE`.
- Probes: `PROBE_ENABLED`, `PROBE_BUDGET_PER_HOUR`, `HEALTH_CHECK_ENABLED`, `HEALTH_CHECK_INTERVAL_MS`.
- TPS probes: `TPS_PROBE_INTERVAL_MS`, `TPS_PROBE_TIMEOUT_MS`, `TPS_PROBE_MAX_TOKENS`, `TPS_PROBE_PROMPT`.
- Cache: `RESPONSE_CACHE_*`, `CACHED_INPUT_DISCOUNT`.
- Billing: `BILLING_CURRENCY`, `FX_*`, `BUDGET_WARN_RATIO`, `TOKEN_USAGE_RETENTION_DAYS`.
- Operations: `TELEMETRY_*`, `LOG_*`, `SHUTDOWN_DRAIN_MS`, `MAINTENANCE_*`, `BACKUP_*`.

## Config transfer

The dashboard can export and merge-import models, providers, routes, tokens, and TPS settings as JSON. Exports exclude plaintext provider keys by default. With secrets included, keys remain encrypted with the source `APP_SECRET` and only import where that secret matches.

## Database

- SQLite through `node:sqlite`, WAL journaling, foreign keys enabled.
- One process should own the database file. Do not run multiple writers.
- Migrations apply at startup in filename order.
- The registry holds the routing state used on every request. SQLite is durable storage.

## TPS probes

TPS-aware routing uses `PROBE_ENABLED` and the per-route `PROBE_BUDGET_PER_HOUR` setting, with a separate budget counter. A degraded preferred route probes at its configured interval until three measured passes confirm recovery. See [TPS-aware routing](tps-routing.md).
