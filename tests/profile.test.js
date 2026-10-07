const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function load(pool) {
  const routes = new Map(), middleware = [];
  const router = { use: fn => middleware.push(fn), get: (url, handler) => routes.set('get', handler), put: (url, handler) => routes.set('put', handler) };
  const auth = () => {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/routes/profile.routes.js'), 'utf8'), { module: { exports: {} }, require: name => {
    if (name === 'express') return { Router: () => router };
    if (name === '../database/db') return pool;
    if (name === '../middlewares/auth.middleware') return auth;
    if (name === '../data/colonias.json') return require('../src/data/colonias.json');
    throw new Error(name);
  } });
  assert.equal(middleware[0], auth);
  return routes;
}
const response = () => ({ code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
const user = { id: 7, nombre: 'Nuevo', email: 'test@example.test', telefono: '6121234567', colonia: 'Centro' };
const request = body => ({ user: { id: 7 }, body });
test('profile reads only the authenticated account and excludes credential columns', async () => {
  const routes = load({ query: async (sql, args) => { assert.ok(sql.includes('WHERE id=$1')); assert.ok(!sql.includes('*') && !sql.includes('password') && !sql.includes('push_token')); assert.equal(args[0], 7); return { rows: [user] }; } });
  const res = response(); await routes.get('get')(request({ id: 999 }), res); assert.equal(res.body.user.id, 7);
});
test('profile updates normalized values only for the JWT owner', async () => {
  const routes = load({ query: async (sql, args) => {
    assert.ok(sql.includes('WHERE id=$4')); assert.ok(!sql.includes('SET email') && !sql.includes('password'));
    assert.deepEqual(Array.from(args), ['Nuevo', '6121234567', 'Centro', 7]); return { rows: [user] };
  } });
  const res = response(); await routes.get('put')(request({ nombre: ' Nuevo ', telefono: ' 6121234567 ', colonia: ' Centro ' }), res);
  assert.equal(res.code, 200); assert.equal(res.body.user.colonia, 'Centro');
});
test('malformed profile, invented colony and mass assignment are rejected before SQL', async () => {
  const routes = load({ query: () => assert.fail('Unexpected SQL') });
  const good = { nombre: 'Nuevo', telefono: '6121234567', colonia: 'Centro' };
  for (const body of [null, [], {}, { ...good, id: 999 }, { ...good, email: 'other@example.test' }, { ...good, push_token: 'secret' },
    { ...good, nombre: 'a'.repeat(101) }, { ...good, nombre: 'bad\nname' }, { ...good, telefono: '123' }, { ...good, telefono: '1234567890123456' }, { ...good, colonia: 'Inventada' }]) {
    const res = response(); await routes.get('put')(request(body), res); assert.equal(res.code, 400);
  }
});
test('missing account and database outage have explicit errors without leaking diagnostics', async () => {
  for (const method of ['get', 'put']) {
    const req = request({ nombre: 'Nuevo', telefono: '6121234567', colonia: 'Centro' });
    let res = response(); await load({ query: async () => ({ rows: [] }) }).get(method)(req, res); assert.equal(res.code, 404);
    res = response(); await load({ query: async () => { throw new Error('secret connection string'); } }).get(method)(req, res);
    assert.equal(res.code, 503); assert.ok(!res.body.error.includes('secret'));
  }
});
