ALTER TABLE pedidos_pipa ADD COLUMN IF NOT EXISTS precio_centavos INTEGER
  CHECK (precio_centavos BETWEEN 1 AND 10000000);
ALTER TABLE pedidos_pipa ADD COLUMN IF NOT EXISTS cotizacion_version INTEGER NOT NULL DEFAULT 0
  CHECK (cotizacion_version >= 0);
ALTER TABLE pedidos_pipa ADD COLUMN IF NOT EXISTS cotizacion_notas VARCHAR(500) NOT NULL DEFAULT '';
ALTER TABLE pedidos_pipa ADD COLUMN IF NOT EXISTS llegada_estimada_minutos INTEGER
  CHECK (llegada_estimada_minutos BETWEEN 1 AND 1440);
ALTER TABLE pedidos_pipa ADD COLUMN IF NOT EXISTS precio_aceptado_en TIMESTAMPTZ;
