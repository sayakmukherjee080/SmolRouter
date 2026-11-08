# Contributing to SmolRouter

Thanks for contributing. SmolRouter is a zero-dependency, single-process Node gateway. Keep changes small, testable, and dependency-free.

## Constraints

1. **Runtime dependencies: none.** Do not add npm packages. Use Node built-ins (`node:http`, `node:sqlite`, `node:crypto`, `fetch`, `Intl`). The admin UI is plain HTML/CSS/ES modules with no build step.
2. **JavaScript only.** No TypeScript, `.ts`/`.tsx`, `tsconfig`, or a compile step. Document functions with comments; do not add type-only tooling.
3. **Node 22.13+.** `node:sqlite` is required. The process is single-instance; there is no worker or external queue.
4. **SQLite only.** Raw SQL migrations in `/migrations`. Do not introduce a database server.
5. **No prompt content storage.** Analytics may store request/token/cost metadata only. Do not add columns, logs, or APIs for prompt or completion content.

## Layout

- `src/server.js` — composition root, HTTP adapter, graceful shutdown.
- `src/gateway/` — proxy, routing, budgets, pricing, FX, cache, telemetry, probes.
- `src/store/` — registry, SQLite, migrations runner, mutations, backups, maintenance.
- `src/admin/` — admin API, sessions/CSRF, static UI.
- `web/` — admin UI (ES modules, no framework).
- `test/` — `node:test` suites and stub upstreams.
- `migrations/` — ordered SQL migrations.
- `docs/` — user and operator documentation; the README is the landing page.

## Development

```bash
npm test
```

Tests use temporary SQLite databases and stub upstreams; no live provider is required. Add tests for changed behavior, especially concurrency, budget windows, routing, and security. Critical paths need assertions on the protected property, not just a 200.

For manual checks:

```bash
npm run setup
npm start
```

`setup` creates `.env`, the database, migrations, and the admin account. Never commit `.env`, `storage/`, or real provider keys.

## Code style

- Match the existing style: ESM, named exports, one concern per file, comments above functions describing their role.
- Keep files under 600 lines; split by responsibility.
- Parameterise SQL. Never concatenate user input into queries.
- Validate all input at the API boundary, including admin requests.
- No dead code, unused imports, or placeholder TODOs.
- Do not log passwords, tokens, keys, or content.

## Security

- Passwords use scrypt via the built-in verifier; never hand-roll hashing.
- Provider keys are encrypted with AES-256-GCM before storage.
- Admin mutations require a session cookie and the `X-CSRF-Token` header.
- Gateway keys are stored as SHA-256 hashes; the raw key is shown once.
- Do not disable TLS certificate validation; do not add wildcard CORS.
- Audit rows are append-only.

## Pull requests

1. Fork and branch from `main`.
2. Keep commits focused; use conventional commits (`feat:`, `fix:`, `docs:`, `test:`).
3. Run `npm test` before opening the PR.
4. Describe the behavior change and any migration or configuration impact.
5. Update the Postman collection when an endpoint or response shape changes.
6. Update the relevant guide in `/docs` when user-facing behavior changes.
7. Add user-facing changes to `CHANGELOG.md` under the next release version.

By contributing, you agree that your code is licensed under the AGPLv3.
