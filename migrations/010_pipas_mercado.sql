-- Additive marketplace schema. Existing deliveries remain on their original flow.
ALTER TABLE pedidos_pipa DROP CONSTRAINT IF EXISTS pedidos_pipa_litros_check;
ALTER TABLE pedidos_pipa ADD CONSTRAINT pedidos_pipa_litros_check CHECK (litros BETWEEN 1 AND 100000);
ALTER TABLE operadores_pipa DROP CONSTRAINT IF EXISTS operadores_pipa_capacidad_check;
ALTER TABLE operadores_pipa ADD CONSTRAINT operadores_pipa_capacidad_check CHECK (capacidad BETWEEN 1 AND 100000);
ALTER TABLE operadores_pipa ADD COLUMN IF NOT EXISTS posicion_latitud DOUBLE PRECISION CHECK (posicion_latitud BETWEEN -90 AND 90);
ALTER TABLE operadores_pipa ADD COLUMN IF NOT EXISTS posicion_longitud DOUBLE PRECISION CHECK (posicion_longitud BETWEEN -180 AND 180);
ALTER TABLE operadores_pipa ADD COLUMN IF NOT EXISTS posicion_en TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS pipa_cotizaciones (
  id SERIAL PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  operador_referencia INTEGER NOT NULL REFERENCES operadores_pipa(id),
  litros INTEGER NOT NULL CHECK (litros BETWEEN 1 AND 100000),
  latitud DOUBLE PRECISION NOT NULL, longitud DOUBLE PRECISION NOT NULL,
  detalle JSONB NOT NULL, vence_en TIMESTAMPTZ NOT NULL,
  fecha TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE pedidos_pipa ADD COLUMN IF NOT EXISTS mercado_cotizacion_id INTEGER REFERENCES pipa_cotizaciones(id);
ALTER TABLE pedidos_pipa ADD COLUMN IF NOT EXISTS tarifa_detalle JSONB;
ALTER TABLE pedidos_pipa ADD COLUMN IF NOT EXISTS busqueda_vence_en TIMESTAMPTZ;
ALTER TABLE pedidos_pipa ADD COLUMN IF NOT EXISTS ruta_actual JSONB;
ALTER TABLE pedidos_pipa ADD COLUMN IF NOT EXISTS ruta_calculada_en TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS pipa_ofertas (
  id SERIAL PRIMARY KEY,
  pedido_id INTEGER NOT NULL REFERENCES pedidos_pipa(id),
  operador_id INTEGER NOT NULL REFERENCES operadores_pipa(id),
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','aceptada','rechazada','vencida','cancelada')),
  distancia_metros INTEGER NOT NULL,
  vence_en TIMESTAMPTZ NOT NULL,
  fecha TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(pedido_id,operador_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS pipa_oferta_vigente ON pipa_ofertas(pedido_id) WHERE estado='pendiente';
CREATE UNIQUE INDEX IF NOT EXISTS pipa_operador_oferta_vigente ON pipa_ofertas(operador_id) WHERE estado='pendiente';
CREATE INDEX IF NOT EXISTS pipa_oferta_operador ON pipa_ofertas(operador_id,vence_en) WHERE estado='pendiente';
-- Preserve the established event function while avoiding a broadcast of timed offers.
DO $$
DECLARE definition TEXT;
BEGIN
  SELECT pg_get_functiondef('notificar_pedido_pipa()'::regprocedure) INTO definition;
  definition := replace(definition, 'IF NEW.estado = ''solicitada'' THEN', 'IF NEW.estado = ''solicitada'' AND NEW.mercado_cotizacion_id IS NULL THEN');
  definition := replace(definition, 'mensaje_cliente := ''Un operador tomó tu pedido. Espera su cotización.'';', 'mensaje_cliente := CASE WHEN NEW.mercado_cotizacion_id IS NULL THEN ''Un operador tomó tu pedido. Espera su cotización.'' ELSE ''Un conductor aceptó tu pedido y el importe confirmado. Abre la entrega para ver sus datos.'' END;');
  EXECUTE definition;
END $$;
