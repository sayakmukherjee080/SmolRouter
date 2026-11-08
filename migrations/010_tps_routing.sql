-- TPS-aware routing: preferred route configuration and response timing telemetry.

ALTER TABLE models ADD COLUMN tps_floor REAL;
ALTER TABLE models ADD COLUMN preferred_route_id INTEGER;
ALTER TABLE models ADD COLUMN tps_probe_interval_ms INTEGER;

ALTER TABLE telemetry ADD COLUMN response_tokens INTEGER;
ALTER TABLE telemetry ADD COLUMN response_ttft_ms INTEGER;
ALTER TABLE telemetry ADD COLUMN response_generation_ms INTEGER;
ALTER TABLE telemetry ADD COLUMN effective_tps REAL;
ALTER TABLE telemetry ADD COLUMN response_tps REAL;

-- response_tokens is completion tokens minus reasoning tokens; response_tps is
-- the generation-only rate, while effective_tps includes time to first output.
CREATE INDEX idx_telemetry_route_ts ON telemetry(route_id, ts);
