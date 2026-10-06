const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(file, pool, extra = {}) {
  const routes = new Map(); const middleware = [];
  const router = { use: fn => middleware.push(fn) };
  for (const method of ['get', 'post', 'put', 'delete']) router[method] = (url, ...handlers) => routes.set(method + ' ' + url, handlers.at(-1));
  const auth = () => {};
  const context = { module: { exports: {} }, console, process, Buffer, fetch: async () => { throw new Error('Unexpected external call'); }, require: name => {
    if (name === 'express') return { Router: () => router };
    if (name === '../database/db') return pool;
    if (name === '../middlewares/auth.middleware') return auth;
    if (extra[name]) return extra[name];
    throw new Error(name);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/' + file), 'utf8'), context);
  return { routes, middleware, auth, exported: context.module.exports };
}
function response() { return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; }
const report = { id: 42, colonia: 'Centro', tipo: 'agua', estado: 'no_agua', comentario: '', usuario_id: 7, client_id: 'stable-key' };
const request = () => ({ user: { id: 7, colonia: 'Centro' }, body: { ...report, usuario_id: 999 }, params: {} });

test('all report and notification routes require authentication', () => {
  for (const file of ['routes/reportes.routes.js', 'routes/notificaciones.routes.js']) {
    const app = load(file, {}); assert.equal(app.middleware[0], app.auth);
  }
});
test('report creation ignores forged user IDs and persists a retry key', async () => {
  const calls = [];
  const app = load('routes/reportes.routes.js', { query: async (sql, values) => { calls.push([sql, values]); return { rows: calls.length === 1 ? [report] : [] }; } });
  const res = response(); await app.routes.get('post /')(request(), res);
  assert.equal(res.statusCode, 201); assert.equal(calls[0][1][4], 7); assert.equal(calls[0][1][5], 'stable-key');
});
test('report retry returns original ID without sending another push', async () => {
  let calls = 0;
  const app = load('routes/reportes.routes.js', { query: async () => ({ rows: ++calls === 1 ? [] : [report] }) });
  const res = response(); await app.routes.get('post /')(request(), res);
  assert.equal(res.body.id, 42); assert.equal(res.body.replayed, true); assert.equal(calls, 2);
});
test('foreign colonia and malformed report are rejected before database access', async () => {
  const app = load('routes/reportes.routes.js', { query: () => { throw new Error('Must not query'); } });
  let req = request(); req.body.colonia = 'Otra'; let res = response(); await app.routes.get('post /')(req, res); assert.equal(res.statusCode, 403);
  req = request(); delete req.body.client_id; res = response(); await app.routes.get('post /')(req, res); assert.equal(res.statusCode, 400);
});
test('confirmation retry locks report and does not insert or resend consensus', async () => {
  const queries = [];
  const client = { release() {}, query: async sql => {
    queries.push(sql);
    if (sql.includes('FOR UPDATE')) return { rows: [{ ...report, usuario_id: 8 }] };
    if (sql.includes('COUNT')) return { rows: [{ total: 3 }] };
    if (sql.startsWith('SELECT decision')) return { rows: [{ decision: 'confirmar' }] };
    return { rows: [] };
  } };
  const app = load('routes/reportes.routes.js', { connect: async () => client });
  const req = request(); req.params.id = '42'; req.body = { decision: 'confirmar', usuario_id: 999 };
  const res = response(); await app.routes.get('post /:id/confirmar')(req, res);
  assert.equal(res.body.confirmaciones, 3); assert.ok(queries.some(q => q.includes('FOR UPDATE')));
  assert.ok(!queries.some(q => q.startsWith('INSERT'))); assert.ok(queries.includes('COMMIT'));
});
test('notification mutation is restricted to recipient', async () => {
  let values;
  const app = load('routes/notificaciones.routes.js', { query: async (sql, args) => { assert.ok(sql.includes('usuario_id = $2')); values = args; return { rows: [] }; } });
  const req = request(); req.params.id = '12'; const res = response(); await app.routes.get('delete /:id')(req, res);
  assert.equal(res.statusCode, 404); assert.deepEqual(Array.from(values), ['12', 7]);
});
test('a user cannot confirm their own report and transaction rolls back', async () => {
  const queries = [];
  const client = { release() {}, query: async sql => { queries.push(sql); return { rows: sql.includes('FOR UPDATE') ? [report] : [] }; } };
  const app = load('routes/reportes.routes.js', { connect: async () => client });
  const req = request(); req.params.id = '42'; req.body = { decision: 'confirmar' }; const res = response();
  await app.routes.get('post /:id/confirmar')(req, res);
  assert.equal(res.statusCode, 403); assert.ok(queries.includes('ROLLBACK')); assert.ok(!queries.includes('COMMIT'));
});
test('reusing a retry key for another payload returns conflict', async () => {
  let calls = 0;
  const app = load('routes/reportes.routes.js', { query: async () => ({ rows: ++calls === 1 ? [] : [report] }) });
  const req = request(); req.body.comentario = 'different'; const res = response();
  await app.routes.get('post /')(req, res); assert.equal(res.statusCode, 409);
});
test('invalid registration is rejected before password hashing or database writes', async () => {
  const app = load('routes/auth.routes.js', { query: () => assert.fail('Unexpected query') }, { bcryptjs: { hash: () => assert.fail('Unexpected hashing') }, jsonwebtoken: {} });
  const req = request(); req.body = { nombre: 'Usuario', email: 'invalid', password: '123' }; const res = response();
  await app.routes.get('post /register')(req, res); assert.equal(res.statusCode, 400);
});
test('authentication rejects missing, malformed and expired tokens without database access', async () => {
  const app = load('middlewares/auth.middleware.js', { query: () => { throw new Error('Must not query'); } }, { jsonwebtoken: { verify: () => { const e = new Error(); e.name = 'TokenExpiredError'; throw e; } } });
  for (const authorization of [undefined, 'Basic abc', 'Bearer expired']) {
    const res = response(); await app.exported({ headers: { authorization } }, res, () => assert.fail('Unexpected next'));
    assert.equal(res.statusCode, 401);
  }
});
