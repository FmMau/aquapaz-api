const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function load(pool) {
  const routes = new Map(); const middleware = [];
  const router = { use: handler => middleware.push(handler) };
  for (const method of ['get', 'post', 'put']) router[method] = (url, handler) => routes.set(`${method} ${url}`, handler);
  const auth = () => {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/routes/pipas.routes.js'), 'utf8'), {
    module: { exports: {} }, console,
    require: name => name === 'express' ? { Router: () => router } : name === '../database/db' ? pool : auth,
  });
  return { routes, middleware, auth };
}
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const payload = { client_id: 'pipa-stable-key', colonia: 'Centro', direccion: 'Morelos 123', referencias: '', telefono: '6121234567', litros: 5000, latitud: 24.125, longitud: -110.32 };
const request = body => ({ user: { id: 7 }, params: { id: '1' }, body });
test('pipa requests are authenticated and invalid coordinates are rejected', async () => {
  const app = load({ query: () => assert.fail('Must not query') });
  assert.equal(app.middleware[0], app.auth);
  for (const invalid of [{ latitud: null }, { litros: '5000' }, { telefono: '123' }, { longitud: 200 }]) {
    const res = response(); await app.routes.get('post /pedidos')(request({ ...payload, ...invalid }), res);
    assert.equal(res.statusCode, 400);
  }
});
test('creation uses authenticated owner and replay rejects changed delivery details', async () => {
  let calls = 0;
  const app = load({ query: async (_, values) => {
    if (++calls === 1) return { rows: [] };
    assert.equal(values[0], 7); return { rows: [{ id: 1, usuario_id: 7, ...payload }] };
  } });
  let res = response(); await app.routes.get('post /pedidos')(request({ ...payload, usuario_id: 99 }), res);
  assert.equal(res.statusCode, 201);
  const replay = load({ query: async () => ({ rows: [{ id: 1, ...payload }] }) });
  res = response(); await replay.routes.get('post /pedidos')(request(payload), res); assert.equal(res.statusCode, 200);
  res = response(); await replay.routes.get('post /pedidos')(request({ ...payload, direccion: 'Otra calle' }), res); assert.equal(res.statusCode, 409);
});
test('unassigned queue does not expose address, phone or coordinates', async () => {
  let calls = 0;
  const app = load({ query: async sql => {
    if (++calls === 1) return { rows: [{ id: 2, disponible: true, capacidad: 10000 }] };
    const select = sql.split('FROM pedidos_pipa')[0];
    for (const field of ['telefono', 'direccion', 'latitud', 'longitud']) assert.ok(!select.includes(field));
    return { rows: [] };
  } });
  await app.routes.get('get /disponibles')(request(), response()); assert.equal(calls, 2);
});
test('another operator losing acceptance rolls back and does not overwrite assignment', async () => {
  const queries = [];
  const client = { release() {}, query: async sql => {
    queries.push(sql);
    if (sql.includes('FOR UPDATE')) return { rows: [{ id: 2, disponible: true, capacidad: 10000 }] };
    if (sql.startsWith('UPDATE')) assert.ok(sql.includes("estado='solicitada'"));
    return { rows: [] };
  } };
  const app = load({ connect: async () => client }); const res = response();
  await app.routes.get('post /pedidos/:id/aceptar')(request(), res);
  assert.equal(res.statusCode, 409); assert.ok(queries.includes('ROLLBACK')); assert.ok(!queries.includes('COMMIT'));
});
test('delivery transitions require assigned operator and expected previous state', async () => {
  const app = load({ query: async (sql, values) => {
    assert.ok(sql.includes('operador_id IN')); assert.equal(values[2], 'asignada'); assert.equal(values[3], 7);
    return { rows: [] };
  } });
  let res = response(); await app.routes.get('put /pedidos/:id/estado')(request({ estado: 'en_camino' }), res); assert.equal(res.statusCode, 409);
  res = response(); await app.routes.get('put /pedidos/:id/estado')(request({ estado: 'cancelada' }), res); assert.equal(res.statusCode, 400);
});
test('customer cancellation is restricted to owner before travel begins', async () => {
  const app = load({ query: async (sql, values) => {
    assert.ok(sql.includes('usuario_id=$2')); assert.ok(sql.includes("estado IN ('solicitada','asignada')"));
    assert.equal(values[1], 7); return { rows: [] };
  } });
  const res = response(); await app.routes.get('post /pedidos/:id/cancelar')(request(), res); assert.equal(res.statusCode, 409);
});

test('PostgreSQL enforces one active order per customer and operator through the full delivery flow', { skip: process.env.RUN_DB_TESTS !== '1' }, async () => {
  require('dotenv').config({ quiet: true });
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
  const schema = `pipas_test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const proxy = { query: (sql, values) => client.query(sql === 'BEGIN' ? 'SAVEPOINT route_test' : sql === 'COMMIT' ? 'RELEASE SAVEPOINT route_test' : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT route_test' : sql, values), release() {} };
  const app = load({ query: proxy.query, connect: async () => proxy });
  async function invoke(route, id, body, orderId = '1') {
    const res = response(); await app.routes.get(route)({ user: { id }, body, params: { id: orderId } }, res); return res;
  }
  try {
    await client.connect(); await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query('CREATE TABLE usuarios (id INTEGER PRIMARY KEY)');
    await client.query('INSERT INTO usuarios VALUES (7),(8),(9),(10)');
    await client.query(fs.readFileSync(path.join(__dirname, '../migrations/002_pipas.sql'), 'utf8'));
    let result = await invoke('post /pedidos', 7, payload); assert.equal(result.statusCode, 201);
    result = await invoke('post /pedidos', 7, payload); assert.equal(result.body.id, 1);
    // Recover a constraint failure within the isolated outer test transaction.
    await client.query('SAVEPOINT duplicate_test');
    result = await invoke('post /pedidos', 7, { ...payload, client_id: 'another-stable-key' }); assert.equal(result.statusCode, 409);
    await client.query('ROLLBACK TO SAVEPOINT duplicate_test');
    for (const id of [8, 9]) {
      result = await invoke('post /operador', id, { nombre: 'Pipa de prueba', placas: 'TEST', telefono: '6121234567', capacidad: 10000 }); assert.equal(result.statusCode, 201);
      await invoke('put /operador/disponibilidad', id, { disponible: true });
    }
    result = await invoke('post /pedidos/:id/aceptar', 8); assert.equal(result.body.estado, 'asignada');
    result = await invoke('post /pedidos/:id/aceptar', 9); assert.equal(result.statusCode, 409);
    result = await invoke('put /pedidos/:id/estado', 9, { estado: 'en_camino' }); assert.equal(result.statusCode, 409);
    result = await invoke('put /pedidos/:id/estado', 8, { estado: 'completada' }); assert.equal(result.statusCode, 409);
    result = await invoke('put /pedidos/:id/estado', 8, { estado: 'en_camino' }); assert.equal(result.body.estado, 'en_camino');
    result = await invoke('post /pedidos/:id/cancelar', 7); assert.equal(result.statusCode, 409);
    result = await invoke('put /pedidos/:id/estado', 8, { estado: 'en_sitio' }); assert.equal(result.body.estado, 'en_sitio');
    result = await invoke('put /pedidos/:id/estado', 8, { estado: 'completada' }); assert.equal(result.body.estado, 'completada');
    result = await invoke('post /pedidos', 7, { ...payload, client_id: 'next-stable-key' }); assert.equal(result.statusCode, 201);
    result = await invoke('post /pedidos/:id/aceptar', 8, undefined, String(result.body.id)); assert.equal(result.body.estado, 'asignada');
    result = await invoke('post /pedidos', 10, { ...payload, client_id: 'different-user-key' }); assert.equal(result.statusCode, 201);
    result = await invoke('post /pedidos/:id/aceptar', 8, undefined, String(result.body.id)); assert.equal(result.statusCode, 409);
  } finally { await client.query('ROLLBACK').catch(() => {}); await client.end(); }
});
