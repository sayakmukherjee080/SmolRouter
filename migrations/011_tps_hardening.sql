-- TPS routing hardening: optional TTFT gate, route reset marker, and preference integrity.

ALTER TABLE models ADD COLUMN tps_max_ttft_ms INTEGER;
ALTER TABLE routes ADD COLUMN tps_reset_at INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_models_preferred_route ON models(preferred_route_id);

-- SQLite cannot add a foreign key with ALTER TABLE on an existing table, so the
-- relationship is enforced with triggers equivalent to a same-model FK.
CREATE TRIGGER models_preferred_route_insert
BEFORE INSERT ON models
WHEN NEW.preferred_route_id IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'preferred_route_id must reference an active route of this model')
    WHERE NOT EXISTS (
        SELECT 1 FROM routes
        WHERE id = NEW.preferred_route_id AND model_id = NEW.id AND deleted_at IS NULL
    );
END;

CREATE TRIGGER models_preferred_route_update
BEFORE UPDATE OF preferred_route_id ON models
WHEN NEW.preferred_route_id IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'preferred_route_id must reference an active route of this model')
    WHERE NOT EXISTS (
        SELECT 1 FROM routes
        WHERE id = NEW.preferred_route_id AND model_id = NEW.id AND deleted_at IS NULL
    );
END;

CREATE TRIGGER routes_preferred_route_delete
BEFORE DELETE ON routes
BEGIN
    UPDATE models SET preferred_route_id = NULL WHERE preferred_route_id = OLD.id;
END;

CREATE TRIGGER routes_preferred_route_soft_delete
AFTER UPDATE OF deleted_at ON routes
WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
BEGIN
    UPDATE models SET preferred_route_id = NULL WHERE preferred_route_id = NEW.id;
END;
