# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0] - 2026-11-08

### Changed

- Renamed the product and repository from SmolOrchestrator to SmolRouter.
- Renamed the npm package to `smolrouter`, the Postman collection to `smolrouter.postman_collection.json`, the logo asset to `smolrouter_logo.png`, and the config download prefix to `smolrouter-config-`.
- Renamed the provider response header from `X-Smolorchestrator-Provider` to `X-SmolRouter-Provider`, the outbound user-agent to `smolrouter/2.0`, the Prometheus metric prefix to `smolrouter_*`, and the `/v1/models` owner to `smolrouter`.
- Updated the admin UI, docs, and setup output to use the new name.
- The logo image, visual style, and other branding elements are unchanged.

### Breaking

- Clients that read the old `X-Smolorchestrator-Provider` header must use `X-SmolRouter-Provider`.
- Dashboards and alerts that query `smolorchestrator_*` Prometheus metrics must use `smolrouter_*`.

## [2.1.0] - 2026-11-08

### Added

- TPS-aware routing: preferred route per model, effective-TPS floor, demotion at 10 of the last 12 samples, fallback routing, and recovery probes.
- Model fields `tpsFloor`, `preferredRouteId`, `tpsProbeIntervalMs`, and `tpsMaxTtftMs`.
- Probe worker with per-model interval, one in-flight probe per route, probe budget, manual probe endpoint, restart hydration, and route/provider reset markers.
- Response timing telemetry: response tokens, content TTFT, generation time, effective TPS, and content TPS.
- TPS status in the models API and UI, a 24-hour TPS report in the usage API and UI, and probe budget controls in settings.
- Migrations `010_tps_routing.sql` and `011_tps_hardening.sql`.
- `POST /api/v1/models/:id/tps/probe`.
- `/docs` guides.

### Changed

- Config export/import includes TPS settings.
- The README is a landing page; detailed documentation moved to `/docs`.

### Fixed

- Probes retry non-streaming when streaming usage is missing, and retry short output with a larger token budget.
- Inconclusive probes no longer reset the restore streak.
- Probes abort on shutdown. `401`/`403` disable the key; `429`, timeouts, and missing keys are handled.
- Route priority, quota, and pricing edits no longer clear TPS state. Provider/upstream repoints and provider base-URL changes reset TPS history.
- TPS validation rejects arrays, booleans, invalid numeric strings, and preferred routes from another model.
- User samples exclude provider-cache reads; probes can reuse a cached prompt.
- The TTFT gate excludes samples without a TTFT measurement.
- Array content deltas and non-standard terminal finish reasons are handled.
- TPS hydration ignores samples from before a reset and samples above the TTFT limit.

### Security

- TPS telemetry stores token counts, timings, and rates only.
- Probe telemetry is excluded from user usage and TPS samples.

## [2.0.0] - 2026-11-08

### Added

- Node.js 22.13+ gateway with SQLite, no runtime dependencies, and no build step.
- OpenAI-compatible proxy, model aliases and routes, priority tiers, and round-robin, least-used, and cache-aware balancing.
- Provider key pools, failover, cooldowns, recovery probes, and proactive health checks.
- Capability routing, exact response cache, singleflight, and prompt-cache savings.
- Upstream and downstream pricing, per-key budget rules, currency conversion, and LiteLLM-compatible surfaces.
- Attempt telemetry, usage, latency reports, Prometheus metrics, audit rows, backups, restore tooling, retention, and config transfer.
- Admin UI in plain HTML, CSS, and ES modules.
- scrypt passwords, signed sessions, CSRF tokens, AES-256-GCM provider keys, SHA-256 gateway keys, password rotation, login lockout, and IP rate limiting.
- Migration checksums, soft-delete tombstones, and no-content schema checks.

### Changed

- The PHP 1.x implementation moved to `legacy/`. The Node gateway is the active implementation.

### Fixed

- Soft-deleted names and token hashes can be reused.
- Settings and usage interactions were corrected.
- Billing, budget, and gateway-limit edge cases were fixed.
- File-cache/database sync and global quota-lock issues from 1.x were resolved.

## [1.0.0] - 2026-01-02

### Added

- Initial PHP release: OpenAI-compatible gateway, provider mappings, key handling, quota controls, and an admin dashboard.

### Fixed

- File-cache synchronization with the database.
- Global max-quota lock behavior.
