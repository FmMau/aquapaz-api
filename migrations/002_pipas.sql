CREATE TABLE IF NOT EXISTS operadores_pipa (
  id SERIAL PRIMARY KEY,
  usuario_id INTEGER NOT NULL UNIQUE REFERENCES usuarios(id),
  nombre VARCHAR(100) NOT NULL,
  placas VARCHAR(20) NOT NULL,
  telefono VARCHAR(20) NOT NULL,
  capacidad INTEGER NOT NULL CHECK (capacidad IN (5000, 10000, 20000)),
  disponible BOOLEAN NOT NULL DEFAULT false,
  fecha TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pedidos_pipa (
  id SERIAL PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  operador_id INTEGER REFERENCES operadores_pipa(id),
  client_id VARCHAR(128) NOT NULL,
  colonia VARCHAR(100) NOT NULL,
  direccion VARCHAR(300) NOT NULL,
  referencias VARCHAR(500) NOT NULL DEFAULT '',
  telefono VARCHAR(20) NOT NULL,
  litros INTEGER NOT NULL CHECK (litros IN (5000, 10000, 20000)),
  latitud DOUBLE PRECISION NOT NULL CHECK (latitud BETWEEN -90 AND 90),
  longitud DOUBLE PRECISION NOT NULL CHECK (longitud BETWEEN -180 AND 180),
  estado VARCHAR(20) NOT NULL DEFAULT 'solicitada'
    CHECK (estado IN ('solicitada', 'asignada', 'en_camino', 'en_sitio', 'completada', 'cancelada')),
  fecha TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (usuario_id, client_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS pedidos_pipa_cliente_activo ON pedidos_pipa(usuario_id)
  WHERE estado NOT IN ('completada', 'cancelada');
CREATE UNIQUE INDEX IF NOT EXISTS pedidos_pipa_operador_activo ON pedidos_pipa(operador_id)
  WHERE operador_id IS NOT NULL AND estado NOT IN ('completada', 'cancelada');
