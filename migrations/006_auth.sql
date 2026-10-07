ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS usuarios_email_normalizado ON usuarios (lower(btrim(email)));
CREATE TABLE IF NOT EXISTS auth_identities (
  id SERIAL PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('google','apple')),
  subject TEXT NOT NULL,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  UNIQUE(provider,subject), UNIQUE(provider,usuario_id)
);
CREATE TABLE IF NOT EXISTS auth_resets (
  id SERIAL PRIMARY KEY,
  usuario_id INTEGER NOT NULL UNIQUE REFERENCES usuarios(id),
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS auth_flows (
  id SERIAL PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  nonce TEXT NOT NULL,
  provider_verifier TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_tickets (
  id SERIAL PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT NOT NULL,
  nombre TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_limits (
  id SERIAL PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  hits INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
