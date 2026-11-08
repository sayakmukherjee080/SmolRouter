# Installation

## Requirements

- Node.js 22.13 or newer.
- A writable `storage/` directory for the database, logs, and backups.
- No database server, container runtime, Python, or cron daemon.

## Setup

```bash
npm run setup
```

The installer:

1. runs `npm install` (there are no runtime dependencies),
2. prompts for the admin email and password,
3. generates `APP_SECRET`,
4. writes `.env`,
5. creates `storage/gateway.db` and applies migrations,
6. writes `storage/install.lock`.

If `storage/install.lock` already exists, the installer stops instead of reinitializing the instance.

## Start

```bash
npm start
```

Defaults:

- Gateway: `http://127.0.0.1:8787/v1`
- Admin UI: `http://127.0.0.1:8787/admin`

## Reverse proxy or tunnel

Put a reverse proxy or tunnel in front of the gateway when exposing it beyond localhost.

Example quick tunnel:

```bash
cloudflared tunnel --url http://127.0.0.1:8787
```

When traffic arrives through a trusted proxy or tunnel, set:

```env
TRUST_PROXY=true
```

Client IPs then come from `CF-Connecting-IP` or `X-Forwarded-For` instead of the socket address. Do not enable this when clients can set those headers themselves.

The gateway does not terminate TLS. Enforce HTTPS at the proxy and keep `COOKIE_SECURE=true` in production.

## Upgrade

1. Stop the gateway.
2. Back up `storage/gateway.db`.
3. Replace the application files.
4. Start the gateway. Pending migrations apply automatically.
5. Check `GET /health/ready` and the admin UI.

Migrations are forward-only. If a migration fails, restore the backup.

## Restore

```bash
npm run db:restore -- storage/backups/<backup>.db --yes
```

The restore tool validates the snapshot, writes a `pre-restore` safety copy, replaces the database, and verifies the restored file.

For partial moves between instances, use config export/import in the dashboard.

## Configuration

All environment variables are documented in [`.env.example`](../.env.example). Runtime settings are available in the admin Settings section. Settings marked as requiring a restart affect timers or startup behavior.

Do not commit `.env`, `storage/`, or provider keys.
