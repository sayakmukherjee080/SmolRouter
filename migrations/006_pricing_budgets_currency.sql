-- Downstream pricing, unified budget rules, token usage events, and FX billing columns.

ALTER TABLE models ADD COLUMN downstream_input_cost_per_m REAL;
ALTER TABLE models ADD COLUMN downstream_output_cost_per_m REAL;
ALTER TABLE models ADD COLUMN downstream_cached_input_cost_per_m REAL;

ALTER TABLE tokens ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';

ALTER TABLE telemetry ADD COLUMN downstream_cost REAL NOT NULL DEFAULT 0;
ALTER TABLE telemetry ADD COLUMN currency TEXT;
ALTER TABLE telemetry ADD COLUMN fx_rate REAL;

ALTER TABLE usage ADD COLUMN downstream_cost REAL NOT NULL DEFAULT 0;
ALTER TABLE usage ADD COLUMN currency TEXT;
ALTER TABLE usage ADD COLUMN fx_rate REAL;

CREATE TABLE token_budget_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id INTEGER NOT NULL REFERENCES tokens(id),
    metric TEXT NOT NULL CHECK (metric IN ('requests', 'tokens_in', 'tokens_out', 'tokens_total', 'amount')),
    period TEXT NOT NULL CHECK (period IN ('hour', 'n_hours', 'day', 'n_days', 'week', 'month')),
    period_count INTEGER NOT NULL DEFAULT 1,
    limit_value REAL NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    reset_time INTEGER NOT NULL DEFAULT 0,
    anchor TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_token_budget_rules_token ON token_budget_rules(token_id, enabled);

CREATE TABLE token_usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    token_id INTEGER NOT NULL,
    requests INTEGER NOT NULL DEFAULT 1,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    downstream_cost REAL NOT NULL DEFAULT 0,
    currency TEXT,
    fx_rate REAL,
    is_cache INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_token_usage_events_token_ts ON token_usage_events(token_id, ts);

-- Convert legacy per-token caps into unified rules.
INSERT INTO token_budget_rules
    (token_id, metric, period, period_count, limit_value, timezone, reset_time, anchor, enabled, created_at)
SELECT id, 'requests', 'day', 1, daily_request_limit, 'UTC', 0, NULL, 1, created_at
FROM tokens WHERE daily_request_limit IS NOT NULL;

INSERT INTO token_budget_rules
    (token_id, metric, period, period_count, limit_value, timezone, reset_time, anchor, enabled, created_at)
SELECT id, 'requests', 'month', 1, monthly_request_limit, 'UTC', 0, NULL, 1, created_at
FROM tokens WHERE monthly_request_limit IS NOT NULL;

INSERT INTO token_budget_rules
    (token_id, metric, period, period_count, limit_value, timezone, reset_time, anchor, enabled, created_at)
SELECT id, 'amount', 'day', 1, daily_spend_limit, 'UTC', 0, NULL, 1, created_at
FROM tokens WHERE daily_spend_limit IS NOT NULL;

INSERT INTO token_budget_rules
    (token_id, metric, period, period_count, limit_value, timezone, reset_time, anchor, enabled, created_at)
SELECT id, 'amount', 'month', 1, monthly_spend_limit, 'UTC', 0, NULL, 1, created_at
FROM tokens WHERE monthly_spend_limit IS NOT NULL;
