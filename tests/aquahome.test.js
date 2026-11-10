const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const { createRouter, volume, present } = require('../src/routes/aquahome.routes');

test('calibration interpolates measured points, endpoints and stale readings', () => {
  for (const [mm, liters] of [[220, 0], [166, 1], [115, 2], [57, 3], [193, 0.5], [140.5, 1.5], [86, 2.5], [300, 0], [30, 3]]) assert.equal(volume(mm), liters);
  const now = Date.now(), row = { public_id: 'test', received_at: new Date(now), sensor_status: 'ok', distance_mm: 115 };
  assert.equal(present(row, now).liters, 2);
  assert.equal(present(row, now + 31000).liters, null);
  assert.equal(present(row, now + 31000).status, 'offline');
  assert.equal(present({ ...row, distance_mm: 300 }, now).status, 'uncalibrated');
  assert.equal(present({ ...row, distance_mm: null, sensor_status: 'no_data' }, now).liters, null);
});

test('HTTP AquaHome persists telemetry, isolates owners, rotates and revokes keys', async () => {
  const db = new PGlite();
  let server;
  try {
    await db.exec('CREATE TABLE usuarios (id SERIAL PRIMARY KEY); INSERT INTO usuarios(id) VALUES (1),(2)');
    const sql = fs.readFileSync(path.join(__dirname, '../migrations/009_aquahome.sql'), 'utf8');
    await db.exec(sql); await db.exec(sql); // migration is repeatable
    const app = express(); app.use(express.json());
    app.use('/api/aquahome', createRouter({ pool: db, auth: (req, res, next) => {
      const owner = Number(req.get('X-Test-Owner'));
      if (![1, 2].includes(owner)) return res.status(401).json({ error: 'Auth' });
      req.user = { id: owner }; next();
    } }));
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/aquahome`;
    const call = async (route, method = 'GET', body, headers = {}) => {
      const r = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: r.status, body: await r.json() };
    };
    const owner = { 'X-Test-Owner': '1' }, other = { 'X-Test-Owner': '2' };
    assert.equal((await call('/dispositivos')).status, 401);
    assert.equal((await call('/dispositivos', 'POST', { nombre: '' }, owner)).status, 400);
    const created = await call('/dispositivos', 'POST', { nombre: 'Cubeta feria' }, owner);
    assert.equal(created.status, 201);
    const id = created.body.device.id, key = created.body.device_key;
    assert.match(key, /^[a-f0-9]{64}$/);
    const stored = (await db.query('SELECT * FROM aquahome_devices')).rows[0];
    assert.notEqual(stored.key_hash, key);
    assert.deepEqual((await call('/dispositivos', 'GET', undefined, other)).body.devices, []);
    assert.equal((await call(`/dispositivos/${id}/credencial`, 'POST', {}, other)).status, 404);
    assert.equal((await call(`/dispositivos/${id}`, 'DELETE', undefined, other)).status, 404);
    assert.equal((await call('/mediciones', 'POST', { status: 'ok', distance_mm: 115 })).status, 401);
    const deviceHeaders = { 'X-Device-Key': key };
    for (const body of [{ status: 'ok', distance_mm: '115' }, { status: 'ok', distance_mm: 0 }, { status: 'no_data', distance_mm: 115 }, { status: 'wrong', distance_mm: null }]) {
      assert.equal((await call('/mediciones', 'POST', body, deviceHeaders)).status, 400);
    }
    assert.equal((await call('/mediciones', 'POST', { status: 'ok', distance_mm: 115 }, deviceHeaders)).status, 200);
    assert.equal((await call('/mediciones', 'POST', { status: 'ok', distance_mm: 115 }, deviceHeaders)).status, 429);
    const list = await call('/dispositivos', 'GET', undefined, owner);
    assert.equal(list.body.devices[0].liters, 2); assert.equal(list.body.devices[0].status, 'online');
    assert.ok(!JSON.stringify(list.body).includes(key)); assert.equal(list.body.devices[0].key_hash, undefined);
    await db.exec("UPDATE aquahome_devices SET received_at = CURRENT_TIMESTAMP - INTERVAL '31 seconds'");
    assert.equal((await call('/dispositivos', 'GET', undefined, owner)).body.devices[0].status, 'offline');
    assert.equal((await call('/mediciones', 'POST', { status: 'no_data', distance_mm: null }, deviceHeaders)).status, 200);
    assert.equal((await call('/dispositivos', 'GET', undefined, owner)).body.devices[0].liters, null);
    const rotated = await call(`/dispositivos/${id}/credencial`, 'POST', {}, owner);
    assert.equal(rotated.status, 200);
    assert.equal((await call('/mediciones', 'POST', { status: 'ok', distance_mm: 115 }, deviceHeaders)).status, 401);
    assert.equal((await call('/mediciones', 'POST', { status: 'ok', distance_mm: 115 }, { 'X-Device-Key': rotated.body.device_key })).status, 200);
    assert.equal((await call(`/dispositivos/${id}`, 'DELETE', undefined, owner)).status, 200);
    assert.equal((await call('/mediciones', 'POST', { status: 'ok', distance_mm: 115 }, { 'X-Device-Key': rotated.body.device_key })).status, 401);
    assert.deepEqual((await call('/dispositivos', 'GET', undefined, owner)).body.devices, []);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await db.close();
  }
});
