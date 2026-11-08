# Billing and Budgets

SmolRouter keeps upstream costs and downstream prices separate.

## Upstream pricing

Each model route has input and output USD prices per million tokens.

- Blank prices use the built-in reference map.
- Explicit prices override the map.
- Providers that report `usage.cost` (for example OpenRouter) store the actual cost as `upstream_cost`.

## Downstream pricing

A model alias can have optional downstream input, output, and cached-input prices per million tokens. Prices are tagged with the `BILLING_CURRENCY` active when saved.

- Blank downstream prices pass through the converted upstream cost.
- Downstream prices can be set when the upstream route is free.
- Clients see downstream prices in `/model/info`. Admins see both layers.

## Budget rules

Each gateway key can have rules by:

- metric: `requests`, `tokens_in`, `tokens_out`, `tokens_total`, or `amount`,
- period: `hour`, every N hours, `day`, every N days, `week`, or `month`,
- timezone, reset time, and anchor.

Rules are checked synchronously at admission. Failed or aborted requests release their reservation. Cache hits count as requests and consume cached tokens or amount.

When a request omits `max_tokens`, token and amount reservations cover only the input estimate. Output is reconciled after the response, so concurrent requests can exceed the cap by in-flight output. Set `max_tokens` when a hard cap must be exact.

Rule windows longer than `TOKEN_USAGE_RETENTION_DAYS` are rejected so counters can be rebuilt from retained events.

## Currency and FX

`BILLING_CURRENCY` is set in the environment and in Settings.

- Upstream USD costs are converted through `FX_API_URL` (default Frankfurter).
- FX rates are cached and single-flight.
- `FX_API_KEY` is optional.
- `FX_MAX_STALE_MS` bounds fallback after refresh failures.
- Amount rules and downstream prices are tagged with their currency.

Changing the currency while model prices, amount rules, or monetary usage exist requires `convertCurrency: true` in the settings request. Conversion:

1. blocks new gateway admissions,
2. drains in-flight requests up to `CURRENCY_CHANGE_DRAIN_MS`,
3. flushes billing telemetry,
4. updates prices, limits, and current billing events in one transaction.

Historical usage rows keep their original currency and rate. Margin is unavailable when a legacy non-USD row has no stored FX rate.

Pre-feature spend caps were USD. When the active currency is not USD, Settings flags legacy amount rules and events for review.

## LiteLLM-compatible surface

- `GET /model/info`: client-facing downstream prices, including cached-input price and route-dependent ranges. Authenticate with a gateway key.
- `GET /key/info`: total amount-rule spend, budget reset, and rules. Authenticate with a gateway key.
- Admin views: `/api/v1/model-info` and per-token rules at `/api/v1/tokens/:id`.

`tpm_limit`, `rpm_limit`, `soft_budget`, and `max_parallel_requests` are not implemented. `max_output_tokens` is reported as `null` until an output limit exists.

## Client cost visibility

Clients that read `models.dev` or a custom provider `cost` block do not automatically see gateway downstream prices. Use the dashboard or `/key/info` for spend and quota data. OpenCode, for example, reads costs from models.dev or its own provider cost block.

## Privacy

Billing and analytics store request, token, and cost metadata only. There is no column, log, or API for prompt or completion content. The optional response cache is the only transient content store. Cached bodies live in memory only.

## Upgrade notes

- Migration 007 backfills per-request billing events from retained telemetry.
- Migration 009 restores spend history for legacy amount caps from the upstream estimated cost those caps enforced.
- Pre-unification cache-hit consumption cannot be recovered per token.
- Budget windows older than telemetry retention are only partially backfilled.
