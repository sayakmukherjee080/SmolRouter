-- Provider-reported upstream cost and downstream billing columns.

ALTER TABLE telemetry ADD COLUMN upstream_cost REAL;
ALTER TABLE usage ADD COLUMN upstream_cost REAL;
