const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('PostgreSQL map aggregates latest reports per neighbor and excludes old reports', { skip: process.env.RUN_DB_TESTS !== '1' }, async () => {
  require('dotenv').config({ quiet: true });
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
  const routes = new Map();
  const router = { use() {} };
  for (const method of ['get', 'post']) router[method] = (url, handler) => routes.set(method + ' ' + url, handler);
  const context = { module: { exports: {} }, console, require: name => {
    if (name === 'express') return { Router: () => router };
    if (name === '../database/db') return client;
    if (name === '../middlewares/auth.middleware') return () => {};
    throw new Error(name);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/routes/reportes.routes.js'), 'utf8'), context);
  try {
    await client.connect(); await client.query('BEGIN');
    // Temporary table shadows public.reportes; production rows are untouched.
    await client.query('CREATE TEMP TABLE reportes (id int, colonia text, usuario_id int, tipo text, estado text, fecha timestamp) ON COMMIT DROP');
    await client.query(`INSERT INTO reportes VALUES
      (1,'Centro',1,'agua','no_agua',(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '2 hours'),
      (2,'Centro',1,'agua','tengo_agua',(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '1 hour'),
      (3,'Centro',2,'agua','baja_presion',(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '1 hour'),
      (4,'Centro',3,'agua','no_agua',(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '25 hours'),
      (5,'Centro',4,'fuga','no_agua',(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '1 hour'),
      (6,'Centro',NULL,'agua','no_agua',(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '1 hour')`);
    const res = { status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; } };
    await routes.get('get /mapa')({ user: { id: 1 } }, res);
    assert.equal(res.statusCode, undefined); assert.equal(res.body.colonias.length, 1);
    const colony = res.body.colonias[0];
    assert.equal(colony.no_agua, 0); assert.equal(colony.baja_presion, 1); assert.equal(colony.tengo_agua, 1);
    assert.equal(colony.usuario_id, undefined); assert.equal(colony.comentario, undefined);
    assert.ok(Number.isFinite(Date.parse(colony.expira)));
    assert.ok(colony.ultima_actualizacion.endsWith('Z'));
  } finally { await client.query('ROLLBACK').catch(() => {}); await client.end(); }
});
