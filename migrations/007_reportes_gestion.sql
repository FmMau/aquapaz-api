BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Staff access is provisioned by an administrator in the database, never by signup.
CREATE TABLE IF NOT EXISTS gestion_roles (
  id SERIAL PRIMARY KEY,
  usuario_id INTEGER NOT NULL UNIQUE REFERENCES usuarios(id),
  rol TEXT NOT NULL CHECK (rol IN ('gestor', 'consulta'))
);

ALTER TABLE reportes ADD COLUMN IF NOT EXISTS estado_atencion TEXT NOT NULL DEFAULT 'nuevo'
  CHECK (estado_atencion IN ('nuevo', 'en_revision', 'en_atencion', 'resuelto', 'descartado'));
ALTER TABLE reportes ADD COLUMN IF NOT EXISTS responsable_id INTEGER REFERENCES usuarios(id);
ALTER TABLE reportes ADD COLUMN IF NOT EXISTS version_atencion INTEGER NOT NULL DEFAULT 0 CHECK (version_atencion >= 0);
ALTER TABLE reportes ADD COLUMN IF NOT EXISTS atencion_actualizada_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX IF NOT EXISTS reportes_gestion_estado ON reportes (estado_atencion, fecha DESC, id DESC);
CREATE INDEX IF NOT EXISTS reportes_gestion_responsable ON reportes (responsable_id, fecha DESC, id DESC);

CREATE TABLE IF NOT EXISTS reporte_atenciones (
  id SERIAL PRIMARY KEY,
  reporte_id INTEGER NOT NULL REFERENCES reportes(id),
  actor_id INTEGER NOT NULL REFERENCES usuarios(id),
  estado_anterior TEXT NOT NULL,
  estado_nuevo TEXT NOT NULL,
  responsable_anterior_id INTEGER REFERENCES usuarios(id),
  responsable_nuevo_id INTEGER REFERENCES usuarios(id),
  nota TEXT NOT NULL CHECK (length(btrim(nota)) BETWEEN 1 AND 2000),
  version INTEGER NOT NULL,
  fecha TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (reporte_id, version)
);
COMMIT;
