const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPushWorker, retrySeconds } = require('../src/services/pipa-notifications');
const row = { id: 41, usuario_id: 7, pedido_id: 15, destinatario: 'cliente', titulo: 'Tu pedido de agua', mensaje: 'Pipa en camino',
  push_token_enviado: 'ExpoPushToken[test_token]', push_estado: 'enviando', push_intentos: 1, age_seconds: 10 };
function setup(rows, fetcher) {
  const updates = [], requests = [];
  let claims = 0;
  const pool = { query: async (sql, params) => {
    if (sql.startsWith('WITH ready')) { claims++; assert.ok(sql.includes('SKIP LOCKED')); return { rows }; }
    updates.push({ sql, params }); return { rows: [] };
  } };
  const worker = createPushWorker({ pool, accessToken: undefined, logger: { error: () => assert.fail('Unexpected worker error') },
    fetcher: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return fetcher(url, options); } });
  return { worker, updates, requests, get claims() { return claims; } };
}
const reply = data => ({ ok: true, json: async () => ({ data }) });
test('push includes only the intended owner/order and waits for a receipt', async () => {
  const s = setup([row], async () => reply({ status: 'ok', id: 'receipt-41' }));
  await s.worker.tick();
  assert.deepEqual(s.requests[0].body.data, { tipo: 'pipa', usuario_id: 7, notificacion_id: 41, pedido_id: 15, destinatario: 'cliente' });
  assert.equal(s.requests[0].body.to, row.push_token_enviado);
  assert.equal(s.updates[0].params[0], 'recibo'); assert.equal(s.updates[0].params[3], 900);
});
test('a missing token and an old event stay in the inbox without sending push', async () => {
  const s = setup([{ ...row, push_token_enviado: null }, { ...row, id: 42, age_seconds: 3601 }], () => assert.fail('Unexpected push'));
  await s.worker.tick(); assert.deepEqual(s.updates.map(u => u.params[0]), ['sin_dispositivo', 'expirada']);
});
test('transient failure backs off and permanent credentials failure stops retrying', async () => {
  let s = setup([row], async () => ({ ok: false, status: 503 }));
  await s.worker.tick(); assert.equal(s.updates[0].params[0], 'pendiente'); assert.equal(s.updates[0].params[1], 'HTTP_503');
  assert.equal(s.updates[0].params[3], retrySeconds(1));
  s = setup([row], async () => reply({ status: 'error', details: { error: 'InvalidCredentials' } }));
  await s.worker.tick(); assert.equal(s.updates[0].params[0], 'fallida');
});
test('DeviceNotRegistered removes only the same token, preserving a replacement device', async () => {
  const s = setup([row], async () => reply({ status: 'error', details: { error: 'DeviceNotRegistered' } }));
  await s.worker.tick(); assert.ok(s.updates[0].sql.includes('id=$1 AND push_token=$2'));
  assert.deepEqual(s.updates[0].params, [7, row.push_token_enviado]); assert.equal(s.updates[1].params[0], 'fallida');
});
test('receipt polling never sends again and handles delivery errors', async () => {
  let s = setup([{ ...row, push_estado: 'recibo', push_ticket: 'ticket-41' }], async () => reply({}));
  await s.worker.tick(); assert.ok(s.requests[0].url.endsWith('/getReceipts')); assert.equal(s.updates[0].params[0], 'recibo');
  assert.equal(s.updates[0].params[2], 'ticket-41');
  s = setup([{ ...row, push_estado: 'recibo', push_ticket: 'ticket-41' }], async () => reply({ 'ticket-41': { status: 'ok' } }));
  await s.worker.tick(); assert.equal(s.updates[0].params[0], 'entregada');
});
test('overlapping polls do not claim or send the same queue twice', async () => {
  let finish;
  const s = setup([row], () => new Promise(resolve => { finish = () => resolve(reply({ status: 'ok', id: 'ticket' })); }));
  const first = s.worker.tick();
  await new Promise(resolve => setImmediate(resolve));
  await s.worker.tick(); assert.equal(s.claims, 1);
  finish(); await first;
});
