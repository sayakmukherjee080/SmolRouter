-- Restore legacy amount-budget history: before downstream pricing existed, spend
-- caps were enforced against the upstream estimated cost. Telemetry rows from that
-- era were backfilled by 007 with downstream_cost 0, so copy est_cost into those
-- events once. Rows with a currency were recorded after pricing existed and are left
-- untouched.
UPDATE token_usage_events AS e
SET downstream_cost = COALESCE((
    SELECT t.est_cost FROM telemetry t
    WHERE t.token_id = e.token_id
      AND t.ts = e.ts
      AND t.is_probe = 0
      AND t.status >= 200
      AND t.status < 400
    ORDER BY t.id
    LIMIT 1
), 0)
WHERE e.is_cache = 0
  AND e.currency IS NULL
  AND e.downstream_cost = 0;
