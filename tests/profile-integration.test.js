const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('HTTP profile editing on PostgreSQL authenticates ownership and preserves unrelated fields', { skip: process.env.RUN_DB_TESTS !== '1' }, async () => {
  require('dotenv').config({ quiet: true });
  const express = require('express'), jwt = require('jsonwebtoken');
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
  let server;
  // Use an isolated signing key and temporary table, never a real account or token.
  const secret = 'isolated-profile-integration-test-key';
  const authContext = { module: { exports: {} }, console, process: { env: { JWT_SECRET: secret } }, require: name => {
    if (name === 'jsonwebtoken') return jwt;
    if (name === '../database/db') return client;
    throw new Error(name);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/middlewares/auth.middleware.js'), 'utf8'), authContext);
  const routeContext = { module: { exports: {} }, require: name => {
    if (name === 'express') return express;
    if (name === '../database/db') return client;
    if (name === '../middlewares/auth.middleware') return authContext.module.exports;
    if (name === '../data/colonias.json') return require('../src/data/colonias.json');
    throw new Error(name);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/routes/profile.routes.js'), 'utf8'), routeContext);
  try {
    await client.connect(); await client.query('BEGIN');
    await client.query('CREATE TEMP TABLE usuarios (id int PRIMARY KEY, nombre varchar(100), email varchar(120), telefono varchar(20), colonia varchar(100), password text, push_token text) ON COMMIT DROP');
    await client.query("INSERT INTO usuarios VALUES (7,'Antes','before@example.test','6121234567','Centro','private-password','private-push'),(8,'Otra cuenta','other@example.test','6121234568','Centro','other-password',NULL)");
    const app = express(); app.use(express.json()); app.use('/api/auth/perfil', routeContext.module.exports);
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const url = `http://127.0.0.1:${server.address().port}/api/auth/perfil`;
    const token = jwt.sign({ id: 7 }, secret, { expiresIn: '1m' });
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    assert.equal((await fetch(url)).status, 401);
    const initial = await (await fetch(url, { headers })).json();
    assert.equal(initial.user.id, 7); assert.equal(initial.user.password, undefined); assert.equal(initial.user.push_token, undefined);
    assert.equal((await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ nombre: 'Otro', telefono: '6121234567', colonia: 'Indeco', id: 8 }) })).status, 400);
    const update = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ nombre: ' Nuevo ', telefono: '+52 6121234567', colonia: 'Indeco' }) });
    assert.equal(update.status, 200); const result = await update.json();
    assert.equal(result.user.nombre, 'Nuevo'); assert.equal(result.user.colonia, 'Indeco'); assert.equal(result.user.email, 'before@example.test');
    const read = await (await fetch(url, { headers })).json(); assert.equal(read.user.telefono, '+52 6121234567');
    const rows = (await client.query('SELECT * FROM usuarios ORDER BY id')).rows;
    assert.equal(rows[0].password, 'private-password'); assert.equal(rows[0].push_token, 'private-push'); assert.equal(rows[1].nombre, 'Otra cuenta');
    assert.equal(rows[1].colonia, 'Centro');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await client.query('ROLLBACK').catch(() => {}); await client.end();
  }
});
