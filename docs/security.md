# Security

## Admin authentication

- Passwords are verified with scrypt.
- Sessions use signed HttpOnly cookies.
- `SESSION_TTL_MS` controls session lifetime.
- Logout clears the session cookie.
- Password changes require the current password and invalidate existing sessions.
- Login attempts are limited and locked out per IP with `LOGIN_MAX_ATTEMPTS` and `LOGIN_LOCKOUT_MS`.

## CSRF

Every state-changing admin endpoint requires:

1. a valid session cookie,
2. `X-CSRF-Token` matching the session CSRF token.

The token is returned by `POST /api/v1/session` and `GET /api/v1/session`.

## Gateway keys

- Stored as SHA-256 hashes.
- The raw key is shown once at creation.
- Scoped to explicit model IDs.
- `/v1/models` returns only models in scope.
- Unknown or out-of-scope models return `404`.

## Provider keys

- Encrypted with AES-256-GCM using `APP_SECRET` before storage.
- Never returned by list endpoints.
- Config export excludes secrets by default. With secrets included, keys remain encrypted with the source `APP_SECRET` and only import where that secret matches.
- TPS probes use the provider key pool directly and do not log key material.

## Content privacy

- Telemetry, usage, audit, and TPS records store metadata only: model, route, and provider IDs; token counts; timings; rates; costs; status; and errors.
- No column, log, or API stores prompt or completion content.
- The optional response cache is the only transient content store. Cached bodies live in memory, are bounded, and can be disabled per model.
- TPS probes keep token counts and timing only. The probe prompt is configuration, not user content.
- Telemetry errors are status or error strings, not response bodies.

## Audit trail

Audit rows are append-only. They record login success and failure, token and key changes, model/route/provider/settings changes, password changes, and admin actions. Fields include actor, action, resource type and ID, IP, UTC timestamp, outcome, and optional JSON details. Maintenance never prunes audit rows.

## Rate limits and request caps

- Gateway requests are limited per IP by `IP_RATE_LIMIT` and `IP_RATE_WINDOW_MS`.
- Request bodies are capped by `MAX_BODY_BYTES`.
- Upstream idle time is bounded by `IDLE_TIMEOUT_MS`.
- Login lockout is separate from gateway rate limiting.
- Route quotas and token budget rules are enforced at admission.

## TLS and proxies

- Enforce HTTPS at the reverse proxy in production.
- Set `COOKIE_SECURE=true` when serving over HTTPS.
- Set `TRUST_PROXY=true` only when a trusted proxy strips client-supplied forwarding headers.
- The gateway does not terminate TLS and does not disable certificate validation for outbound calls.

## Backups

Backups are full SQLite snapshots containing encrypted provider keys, hashed gateway keys, usage, and audit history. Protect them like the live database. The restore tool writes a safety copy before replacing the database.

## Deployment rules

- Do not expose the admin API without TLS and access control at the proxy.
- Do not run multiple gateway processes writing to the same SQLite database.
- Do not commit `.env`, `storage/`, provider keys, gateway keys, or backups.
- Keep `APP_SECRET` stable. Changing it breaks provider-key decryption and existing sessions.

## Reporting

Handle security issues privately. Do not open a public issue containing a live provider key, gateway key, session cookie, or database snapshot.
