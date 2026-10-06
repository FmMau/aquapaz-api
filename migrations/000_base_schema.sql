CREATE TABLE IF NOT EXISTS usuarios (
  id SERIAL PRIMARY KEY,
  nombre VARCHAR(100),
  email VARCHAR(120) UNIQUE,
  telefono VARCHAR(20),
  password VARCHAR(255),
  colonia VARCHAR(100),
  fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  push_token TEXT
);

CREATE TABLE IF NOT EXISTS reportes (
  id SERIAL PRIMARY KEY,
  colonia VARCHAR(100),
  tipo VARCHAR(50),
  estado VARCHAR(50),
  comentario TEXT,
  fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  sincronizado BOOLEAN DEFAULT false,
  usuario_id INTEGER,
  client_id TEXT
);

CREATE TABLE IF NOT EXISTS confirmaciones (
  id SERIAL PRIMARY KEY,
  reporte_id INTEGER,
  decision TEXT,
  usuario_id INTEGER,
  fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (reporte_id, usuario_id)
);

CREATE TABLE IF NOT EXISTS notificaciones (
  id SERIAL PRIMARY KEY,
  mensaje TEXT NOT NULL,
  tipo TEXT NOT NULL,
  leido BOOLEAN NOT NULL DEFAULT false,
  confirmada BOOLEAN NOT NULL DEFAULT false,
  fecha TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  usuario_id INTEGER REFERENCES usuarios(id)
);
