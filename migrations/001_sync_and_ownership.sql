BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE reportes ADD COLUMN IF NOT EXISTS client_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS reportes_usuario_client_id
  ON reportes (usuario_id, client_id) WHERE client_id IS NOT NULL;
-- The deployed database may not yet have the notification table.
CREATE TABLE IF NOT EXISTS notificaciones (
  id SERIAL PRIMARY KEY,
  mensaje TEXT NOT NULL,
  tipo TEXT NOT NULL,
  leido BOOLEAN NOT NULL DEFAULT false,
  confirmada BOOLEAN NOT NULL DEFAULT false,
  fecha TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  usuario_id INTEGER REFERENCES usuarios(id)
);
ALTER TABLE notificaciones ADD COLUMN IF NOT EXISTS usuario_id INTEGER REFERENCES usuarios(id);
-- Existing notifications have no known recipient and remain inaccessible to clients.
COMMIT;
