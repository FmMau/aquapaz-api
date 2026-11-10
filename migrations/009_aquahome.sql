CREATE TABLE IF NOT EXISTS aquahome_devices (
  id SERIAL PRIMARY KEY,
  public_id UUID NOT NULL UNIQUE,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  nombre VARCHAR(80) NOT NULL,
  key_hash CHAR(64) NOT NULL UNIQUE,
  revoked BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  received_at TIMESTAMPTZ,
  sensor_status TEXT CHECK (sensor_status IN ('ok', 'no_data', 'out_of_range')),
  distance_mm INTEGER CHECK (distance_mm BETWEEN 30 AND 4500)
);
CREATE INDEX IF NOT EXISTS aquahome_owner_idx ON aquahome_devices(usuario_id);
