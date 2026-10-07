const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function load(pool) {
  const routes = new Map(); const middleware = [];
  const router = { use: handler => middleware.push(handler) };
  for (const method of ['get', 'post', 'put', 'delete']) router[method] = (url, handler) => routes.set(`${method} ${url}`, handler);
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
    await client.query(fs.readFileSync(path.join(__dirname, '../migrations/000_base_schema.sql'), 'utf8'));
    await client.query('INSERT INTO usuarios (id) VALUES (7),(8),(9),(10)');
    await client.query(fs.readFileSync(path.join(__dirname, '../migrations/002_pipas.sql'), 'utf8'));
    await client.query(fs.readFileSync(path.join(__dirname, '../migrations/003_pipas_cotizaciones.sql'), 'utf8'));
    await client.query(fs.readFileSync(path.join(__dirname, '../migrations/004_pipas_ubicacion.sql'), 'utf8'));
    await client.query(fs.readFileSync(path.join(__dirname, '../migrations/005_pipas_notificaciones.sql'), 'utf8'));
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
    result = await invoke('put /pedidos/:id/estado', 8, { estado: 'en_camino' }); assert.equal(result.statusCode, 409);
    const quote = { precio_centavos: 120050, llegada_estimada_minutos: 30, notas: 'Incluye traslado y descarga', version: 0 };
    result = await invoke('put /pedidos/:id/cotizacion', 9, quote); assert.equal(result.statusCode, 409);
    result = await invoke('put /pedidos/:id/cotizacion', 8, quote); assert.equal(result.body.cotizacion_version, 1);
    // Lost quote responses can be retried without incrementing the version again.
    result = await invoke('put /pedidos/:id/cotizacion', 8, quote); assert.equal(result.body.cotizacion_version, 1);
    result = await invoke('post /pedidos/:id/aceptar-precio', 10, { version: 1, precio_centavos: 120050 }); assert.equal(result.statusCode, 409);
    result = await invoke('put /pedidos/:id/cotizacion', 8, { ...quote, version: 1, precio_centavos: 130075 }); assert.equal(result.body.cotizacion_version, 2);
    result = await invoke('post /pedidos/:id/aceptar-precio', 7, { version: 1, precio_centavos: 120050 }); assert.equal(result.statusCode, 409);
    result = await invoke('post /pedidos/:id/aceptar-precio', 7, { version: 2, precio_centavos: 120050 }); assert.equal(result.statusCode, 409);
    result = await invoke('post /pedidos/:id/aceptar-precio', 7, { version: 2, precio_centavos: 130075 });
    assert.equal(result.statusCode, 200); assert.ok(result.body.precio_aceptado_en);
    const acceptedAt = result.body.precio_aceptado_en.getTime();
    result = await invoke('post /pedidos/:id/aceptar-precio', 7, { version: 2, precio_centavos: 130075 });
    assert.equal(result.body.precio_aceptado_en.getTime(), acceptedAt);
    result = await invoke('put /pedidos/:id/cotizacion', 8, { ...quote, version: 2, precio_centavos: 140000 }); assert.equal(result.statusCode, 409);
    result = await invoke('put /pedidos/:id/estado', 8, { estado: 'en_camino' }); assert.equal(result.body.estado, 'en_camino');
    const sample = { latitud: 24.12, longitud: -110.32, precision: 8, observada_en: Date.now() };
    result = await invoke('put /pedidos/:id/ubicacion', 9, sample); assert.equal(result.statusCode, 409);
    result = await invoke('put /pedidos/:id/ubicacion', 8, sample); assert.equal(result.body.aceptada, true);
    result = await invoke('get /pedidos/:id/ubicacion', 7); assert.equal(result.body.ubicacion.latitud, 24.12);
    result = await invoke('get /pedidos/:id/ubicacion', 9); assert.equal(result.statusCode, 404);
    result = await invoke('get /pedidos/:id/ubicacion', 10); assert.equal(result.statusCode, 404);
    result = await invoke('put /pedidos/:id/ubicacion', 8, { ...sample, observada_en: sample.observada_en - 1000, latitud: 24.11 });
    assert.equal(result.body.aceptada, false); assert.equal(result.body.ubicacion.latitud, 24.12);
    result = await invoke('delete /pedidos/:id/ubicacion', 7); assert.equal(result.statusCode, 404);
    result = await invoke('delete /pedidos/:id/ubicacion', 8); assert.equal(result.body.ubicacion, null);
    result = await invoke('put /pedidos/:id/ubicacion', 8, { ...sample, observada_en: Date.now() }); assert.equal(result.body.aceptada, true);
    result = await invoke('post /pedidos/:id/cancelar', 7); assert.equal(result.statusCode, 409);
    result = await invoke('put /pedidos/:id/estado', 8, { estado: 'en_sitio' }); assert.equal(result.body.estado, 'en_sitio');
    result = await invoke('put /pedidos/:id/estado', 8, { estado: 'completada' }); assert.equal(result.body.estado, 'completada');
    assert.equal(result.body.pipa_latitud, null); assert.equal(result.body.pipa_observada_en, null);
    result = await invoke('put /pedidos/:id/ubicacion', 8, { ...sample, observada_en: Date.now() }); assert.equal(result.statusCode, 409);
    result = await invoke('get /pedidos/:id/ubicacion', 7); assert.equal(result.body.ubicacion, null);
    result = await invoke('post /pedidos', 7, { ...payload, client_id: 'next-stable-key' }); assert.equal(result.statusCode, 201);
    result = await invoke('post /pedidos/:id/aceptar', 8, undefined, String(result.body.id)); assert.equal(result.body.estado, 'asignada');
    result = await invoke('post /pedidos', 10, { ...payload, client_id: 'different-user-key' }); assert.equal(result.statusCode, 201);
    result = await invoke('post /pedidos/:id/aceptar', 8, undefined, String(result.body.id)); assert.equal(result.statusCode, 409);
    const current = (await client.query("SELECT id FROM pedidos_pipa WHERE usuario_id=7 AND estado='asignada'")).rows[0].id;
    result = await invoke('put /pedidos/:id/cotizacion', 8, quote, String(current)); assert.equal(result.body.cotizacion_version, 1);
    result = await invoke('post /pedidos/:id/rechazar-precio', 7, { version: 2 }, String(current)); assert.equal(result.statusCode, 409);
    result = await invoke('post /pedidos/:id/rechazar-precio', 10, { version: 1 }, String(current)); assert.equal(result.statusCode, 409);
    result = await invoke('post /pedidos/:id/rechazar-precio', 7, { version: 1 }, String(current)); assert.equal(result.body.estado, 'cancelada');
    assert.equal(result.body.precio_centavos, 120050); assert.equal(result.body.precio_aceptado_en, null);
    const events = (await client.query('SELECT usuario_id,pedido_id,evento,push_estado FROM notificaciones ORDER BY id')).rows;
    const customerEvents = events.filter(event => event.pedido_id === 1 && event.usuario_id === 7).map(event => event.evento);
    assert.deepEqual(customerEvents, ['asignada', 'cotizacion:1', 'cotizacion:2', 'en_camino', 'en_sitio', 'completada']);
    assert.equal(events.filter(event => event.pedido_id === 1 && event.usuario_id === 8 && event.evento === 'precio_aceptado:2').length, 1);
    assert.equal(events.filter(event => event.pedido_id === current && event.evento === 'cancelada').length, 2);
    assert.ok(events.every(event => event.push_estado === 'pendiente'));
    assert.ok(!events.some(event => event.usuario_id === 9 && event.evento !== 'solicitada'));
    assert.deepEqual(events.filter(event => event.pedido_id === current && event.evento === 'solicitada').map(event => event.usuario_id).sort(), [8, 9]);
    const otherOrder = (await client.query('SELECT id FROM pedidos_pipa WHERE usuario_id=10')).rows[0].id;
    assert.deepEqual(events.filter(event => event.pedido_id === otherOrder && event.evento === 'solicitada').map(event => event.usuario_id), [9]);
    result = await invoke('get /pedidos/:id', 7); assert.equal(result.body.pedido.direccion, payload.direccion);
    result = await invoke('get /pedidos/:id', 8); assert.equal(result.body.pedido.id, 1);
    result = await invoke('get /pedidos/:id', 9); assert.equal(result.statusCode, 404);
    result = await invoke('get /pedidos/:id', 9, undefined, String(otherOrder)); assert.equal(result.body.disponible, true);
    assert.equal(result.body.pedido.telefono, undefined); assert.equal(result.body.pedido.latitud, undefined);
    await client.query('INSERT INTO usuarios (id) VALUES (12)');
    await client.query("INSERT INTO operadores_pipa (usuario_id,nombre,placas,telefono,capacidad,disponible) VALUES (12,'Operador de prueba','TEST12','6121234567',20000,true)");
    result = await invoke('post /pedidos', 12, { ...payload, litros: 20000, client_id: 'capacity-self-test' });
    assert.equal(result.statusCode, 201);
    assert.equal((await client.query('SELECT COUNT(*)::int AS total FROM notificaciones')).rows[0].total, events.length);
    // Backup restoration suppresses trigger notifications even with an active operator.
    const count = events.length;
    await client.query("SET LOCAL aquapaz.restoring = 'on'");
    await client.query("INSERT INTO pedidos_pipa (usuario_id,client_id,colonia,direccion,telefono,litros,latitud,longitud) VALUES (7,'restore-order','Centro','Morelos 123','6121234567',5000,24.12,-110.32)");
    assert.equal((await client.query('SELECT COUNT(*)::int AS total FROM notificaciones')).rows[0].total, count);
    const worker = require('../src/services/pipa-notifications').createPushWorker({
      pool: { query: (sql, params) => client.query(sql, params) }, fetcher: () => assert.fail('Must not send push without a token'),
      logger: { error: code => assert.fail(code) },
    });
    await worker.tick();
    assert.equal((await client.query("SELECT COUNT(*)::int AS total FROM notificaciones WHERE push_estado='sin_dispositivo'")).rows[0].total, 5);
  } finally { await client.query('ROLLBACK').catch(() => {}); await client.end(); }
});

test('GPS validation rejects invalid, old or future coordinates before database access', async () => {
  const app = load({ query: () => assert.fail('Must not query') });
  const sample = { latitud: 24.12, longitud: -110.32, observada_en: Date.now(), precision: 10 };
  for (const invalid of [{ latitud: null }, { longitud: 181 }, { precision: -1 }, { precision: 10001 }, { observada_en: Date.now() - 130000 }, { observada_en: Date.now() + 60000 }, { observada_en: '2026-10-07' }]) {
    const res = response(); await app.routes.get('put /pedidos/:id/ubicacion')(request({ ...sample, ...invalid }), res); assert.equal(res.statusCode, 400);
  }
});

test('invalid quote money, version and ETA are rejected before touching the database', async () => {
  const app = load({ query: () => assert.fail('Must not query') });
  const quote = { precio_centavos: 120050, llegada_estimada_minutos: 30, version: 0 };
  for (const invalid of [{ precio_centavos: 0 }, { precio_centavos: 1200.5 }, { precio_centavos: '120000' }, { precio_centavos: 10000001 }, { llegada_estimada_minutos: 0 }, { version: -1 }, { notas: 'x'.repeat(501) }]) {
    const res = response(); await app.routes.get('put /pedidos/:id/cotizacion')(request({ ...quote, ...invalid }), res); assert.equal(res.statusCode, 400);
  }
});
test('starting travel requires accepted quote in the database, even from old app clients', async () => {
  const app = load({ query: async (sql, values) => {
    assert.ok(sql.includes('precio_centavos IS NOT NULL AND precio_aceptado_en IS NOT NULL'));
    assert.equal(values[0], 'en_camino'); return { rows: [] };
  } });
  const res = response(); await app.routes.get('put /pedidos/:id/estado')(request({ estado: 'en_camino' }), res);
  assert.equal(res.statusCode, 409);
});
test('quote acceptance matches exact owner, quote version and total', async () => {
  const app = load({ query: async (sql, values) => {
    assert.ok(sql.includes('usuario_id=$2')); assert.ok(sql.includes('cotizacion_version=$3 AND precio_centavos=$4'));
    assert.deepEqual(Array.from(values), ['1', 7, 3, 120050]); return { rows: [] };
  } });
  const res = response(); await app.routes.get('post /pedidos/:id/aceptar-precio')(request({ version: 3, precio_centavos: 120050 }), res);
  assert.equal(res.statusCode, 409);
});
