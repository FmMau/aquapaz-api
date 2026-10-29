BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE pedidos_pipa
  ADD COLUMN IF NOT EXISTS gestion_version INTEGER NOT NULL DEFAULT 0
  CHECK (gestion_version >= 0);

CREATE TABLE IF NOT EXISTS pipa_gestion_historial (
  id SERIAL PRIMARY KEY,
  pedido_id INTEGER NOT NULL REFERENCES pedidos_pipa(id),
  actor_id INTEGER NOT NULL REFERENCES usuarios(id),
  accion TEXT NOT NULL CHECK (accion IN ('asignacion', 'nota')),
  operador_id INTEGER REFERENCES operadores_pipa(id),
  estado TEXT NOT NULL,
  nota TEXT NOT NULL CHECK (length(btrim(nota)) BETWEEN 1 AND 2000),
  version INTEGER NOT NULL,
  fecha TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (pedido_id, version)
);

CREATE INDEX IF NOT EXISTS pedidos_pipa_gestion_estado
  ON pedidos_pipa (estado, fecha DESC, id DESC);

-- Existing customer and operator routes also invalidate stale management forms.
-- GPS updates do not invalidate a form unless another business field changes.
CREATE OR REPLACE FUNCTION versionar_gestion_pipa()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.estado IS DISTINCT FROM OLD.estado
    OR NEW.operador_id IS DISTINCT FROM OLD.operador_id
    OR NEW.cotizacion_version IS DISTINCT FROM OLD.cotizacion_version
    OR NEW.precio_aceptado_en IS DISTINCT FROM OLD.precio_aceptado_en THEN
    NEW.gestion_version := OLD.gestion_version + 1;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pedidos_pipa_gestion_version ON pedidos_pipa;

CREATE TRIGGER pedidos_pipa_gestion_version
  BEFORE UPDATE ON pedidos_pipa
  FOR EACH ROW EXECUTE FUNCTION versionar_gestion_pipa();

COMMIT;
