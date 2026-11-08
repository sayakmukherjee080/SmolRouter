<p align="center">
  <img src="assets/smolorchestrator_logo.png" width="150" alt="SmolOrchestrator">
</p>

# SmolOrchestrator

Self-hosted OpenAI-compatible gateway. One Node process, one SQLite database, one admin UI.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-22.13%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![SQLite](https://img.shields.io/badge/SQLite-3-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)

## Overview

SmolOrchestrator sits between OpenAI-compatible clients and one or more upstream providers. Clients authenticate with a gateway key scoped to specific model aliases. The gateway handles routing, key pools, failover, TPS-aware routing, caching, budgets, and telemetry.

There are no runtime npm dependencies, no database server, and no build step. Node 22.13 or newer is required for `node:sqlite`.

## Features

- OpenAI-compatible `POST /v1/chat/completions`, `GET /v1/models`, and generic `/v1/*` JSON paths.
- Model aliases and provider routes with priority tiers and round-robin, least-used, or cache-aware balancing.
- Provider key pools with round-robin rotation and automatic auth-failure benching.
- Failover with capped backoff, cooldowns, recovery probes, and proactive health checks.
- TPS-aware routing with a preferred route, effective-TPS floor, fallback, and recovery probes.
- Exact response cache, singleflight coalescing, and prompt-cache savings tracking.
- Upstream and downstream pricing, per-key budget rules, and currency conversion.
- Capability routing for `tools`, `vision`, `audio`, `json`, `reasoning`, and max context.
- Attempt telemetry, usage reports, latency and TPS reports, Prometheus metrics, and audit rows.
- SQLite backups, restore tooling, retention maintenance, and config export/import.
- Admin UI in plain HTML, CSS, and ES modules.

## Quick start

Requirements: Node.js 22.13 or newer.

```bash
npm run setup
npm start
```

- Gateway: `http://127.0.0.1:8787/v1`
- Admin UI: `http://127.0.0.1:8787/admin`

First request:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer YOUR_GATEWAY_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "your-model-alias",
    "messages": [{ "role": "user", "content": "Hello via SmolOrchestrator." }],
    "stream": true
  }'
```

See [Installation](docs/installation.md) for setup details, reverse proxies, upgrades, and restore.

## Documentation

| Guide | Contents |
| :--- | :--- |
| [Documentation index](docs/README.md) | All guides. |
| [About](docs/about.md) | Design, architecture, tech stack, compatibility. |
| [Installation](docs/installation.md) | Setup, first start, reverse proxy, upgrades, restore. |
| [Usage](docs/usage.md) | Client configuration, requests, headers, dashboard, errors. |
| [TPS-aware routing](docs/tps-routing.md) | Preferred routes, demotion, fallback, probes, configuration. |
| [Billing and budgets](docs/billing.md) | Pricing layers, budget rules, currency, LiteLLM surfaces. |
| [Operations](docs/operations.md) | Health, metrics, jobs, backups, retention, configuration. |
| [API reference](docs/api.md) | Response envelopes, endpoint map, Postman collection. |
| [Security](docs/security.md) | Authentication, key handling, CSRF, privacy, audit. |
| [Development](docs/development.md) | Tests, layout, migrations, contribution rules. |
| [Changelog](CHANGELOG.md) | Release history. |

Every environment variable is documented in [`.env.example`](.env.example). The Postman collection is at [`postman/smolorchestrator.postman_collection.json`](postman/smolorchestrator.postman_collection.json).

## Security and privacy

- Admin passwords use scrypt. Sessions are signed, HttpOnly cookies.
- Admin mutations require a session cookie and `X-CSRF-Token`.
- Gateway keys are SHA-256 hashed and scoped to models.
- Provider keys are AES-256-GCM encrypted at rest and never returned.
- Telemetry, usage, and TPS records store metadata only. Prompt and completion content is not stored.
- The optional response cache keeps response bodies in memory only. It is bounded and can be disabled per model.

See [Security](docs/security.md).

## Compatibility

Any provider that implements the OpenAI API can be used. Tested or documented providers include OpenAI, OpenRouter, Google Gemini's OpenAI-compatible endpoints, Vertex AI adapters, Nvidia NIM, DeepSeek, Groq, and Cerebras.

Other `POST /v1/*` paths are routed when the JSON body contains a `model` field.

## Testing

```bash
npm test
```

Tests use temporary SQLite databases and stub upstreams; no live provider is required. See [Development](docs/development.md).

## License

SmolOrchestrator is licensed under the GNU Affero General Public License v3 (AGPL-3.0). See [LICENSE](LICENSE).
