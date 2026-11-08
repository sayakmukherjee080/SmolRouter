# Development

SmolOrchestrator is a single-process Node gateway with no runtime dependencies. Keep changes small and tested. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the contribution workflow.

## Constraints

1. No runtime npm dependencies. Use Node built-ins such as `node:http`, `node:sqlite`, `node:crypto`, `fetch`, and `Intl`.
2. JavaScript only. No TypeScript, `.ts`/`.tsx`, `tsconfig`, or compile step.
3. Node 22.13 or newer. `node:sqlite` is required.
4. SQLite only. Migrations are raw SQL in `migrations/`.
5. No prompt content storage. Analytics may store request, token, timing, and cost metadata only.
6. Files stay under 600 lines. Split by responsibility.

## Layout

| Path | Role |
| :--- | :--- |
| `src/server.js` | Configuration, HTTP adapter, security headers, graceful shutdown. |
| `src/gateway/` | Proxy, routing, TPS state and probes, budgets, pricing, FX, cache, telemetry. |
| `src/store/` | Registry, SQLite, migrations runner, mutations, backups, maintenance. |
| `src/admin/` | Admin API, sessions and CSRF, static UI server. |
| `web/` | Admin UI: HTML, CSS, ES modules. |
| `test/` | `node:test` suites, stub upstreams, temporary databases. |
| `migrations/` | Ordered SQL migrations. |
| `docs/` | User and operator documentation. |
| `postman/` | API collection. |

## Tests

```bash
npm test
```

Tests use temporary SQLite databases and stub upstreams. No live provider is required.

Add tests for changed behavior, especially:

- authentication and model scoping,
- routing, failover, cooldowns, and key rotation,
- TPS sampling, demotion, fallback, probes, and hydration,
- budget rules and currency conversion,
- response cache and singleflight,
- streaming and usage extraction,
- migrations and schema integrity,
- admin validation and security,
- no-content schema checks.

Critical paths must assert the protected property, not only a `200`. For example, authorization tests assert cross-actor access is rejected, and TPS tests assert the restore threshold and streak behavior.

Manual check:

```bash
npm run setup
npm start
```

Never commit `.env`, `storage/`, or real provider keys.

## Migrations

- One change per file, named `NNN_descriptive_name.sql`.
- The runner applies files in filename order and records a checksum.
- Editing an applied migration is detected as a checksum mismatch. Add a new migration instead.
- Migrations are forward-only; rollback is backup-based. See [Operations](operations.md).
- Add schema tests for new columns, indexes, triggers, and upgrade paths.

## API changes

When an endpoint, field, or response shape changes:

1. update the Postman collection in `/postman`,
2. update [API reference](api.md) when the route is listed,
3. update the relevant guide in `/docs`,
4. update `CHANGELOG.md`,
5. add or update endpoint tests.

## Documentation

- User-facing behavior belongs in `/docs`.
- Keep the README as a short landing page.
- Update [docs/README.md](README.md) when adding a guide.
- Do not put real keys, tokens, cookies, or database snapshots in docs.

## Code style

- ESM, named exports, one concern per file.
- One comment above every function describing its role.
- Keep files under 600 lines.
- Parameterise SQL. Never concatenate user input into queries.
- Validate all input at the API boundary.
- No dead code, unused imports, or placeholder TODOs.
- Do not log passwords, tokens, keys, or content.
- Reuse existing helpers before adding abstractions.

## Security

- Passwords use scrypt. Do not hand-roll hashing.
- Provider keys use AES-256-GCM before storage.
- Admin mutations require a session cookie and CSRF token.
- Gateway keys are SHA-256 hashed; raw keys are shown once.
- Do not disable TLS certificate validation or add wildcard CORS.
- Audit rows are append-only.
- Do not store prompt or completion content in telemetry, logs, or APIs.
