-- Currency tagging for downstream prices and amount rules, and per-currency usage aggregates.

ALTER TABLE models ADD COLUMN downstream_currency TEXT NOT NULL DEFAULT 'USD';

ALTER TABLE token_budget_rules ADD COLUMN currency TEXT;

-- Existing prices and limits were created under the active legacy currency.
UPDATE models
SET downstream_currency = COALESCE(
    NULLIF(TRIM((SELECT value FROM settings WHERE key = 'billing_currency'), '"'), ''),
    'USD'
);

UPDATE token_budget_rules
SET currency = COALESCE(
    NULLIF(TRIM((SELECT value FROM settings WHERE key = 'billing_currency'), '"'), ''),
    'USD'
)
WHERE metric = 'amount';

-- Rebuild usage so mixed currencies never collide in the same aggregate row.
CREATE TABLE usage_currency_rebuild (
    entity TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    window_start INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    requests INTEGER NOT NULL DEFAULT 0,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0,
    saved_cost REAL NOT NULL DEFAULT 0,
    upstream_cost REAL,
    downstream_cost REAL NOT NULL DEFAULT 0,
    fx_rate REAL,
    PRIMARY KEY (entity, entity_id, window_start, currency)
);

INSERT INTO usage_currency_rebuild
    (entity, entity_id, window_start, currency, requests, tokens_in, tokens_out, cached_tokens,
     cost, saved_cost, upstream_cost, downstream_cost, fx_rate)
SELECT entity, entity_id, window_start,
       COALESCE(
           NULLIF(currency, ''),
           NULLIF(TRIM((SELECT value FROM settings WHERE key = 'billing_currency'), '"'), ''),
           'USD'
       ),
       requests, tokens_in, tokens_out, cached_tokens,
       cost, saved_cost, upstream_cost, downstream_cost, fx_rate
FROM usage;

DROP TABLE usage;

ALTER TABLE usage_currency_rebuild RENAME TO usage;

CREATE INDEX idx_usage_window ON usage(entity, window_start);
