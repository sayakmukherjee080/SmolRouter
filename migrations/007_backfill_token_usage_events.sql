-- Backfill per-request token usage from retained telemetry so existing budgets survive the upgrade.
-- Events recorded after migration 006 are already present; skip them by timestamp and token.
INSERT INTO token_usage_events
    (ts, token_id, requests, tokens_in, tokens_out, downstream_cost, currency, fx_rate, is_cache)
SELECT t.ts, t.token_id, 1, t.input_tokens, t.output_tokens,
       COALESCE(t.downstream_cost, 0), t.currency, t.fx_rate, 0
FROM telemetry t
WHERE t.token_id IS NOT NULL
  AND t.is_probe = 0
  AND t.status >= 200
  AND t.status < 400
  AND NOT EXISTS (
    SELECT 1 FROM token_usage_events e
    WHERE e.token_id = t.token_id AND e.ts = t.ts
  );
