const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { tables } = require('../scripts/database-tools');
async function restore(order) {
  const inserts = [];
  const snapshot = { format: 'aquapaz-data-v1', tables: Object.fromEntries(tables.map(table => [table, []])), sequences: {} };
  snapshot.tables.pedidos_pipa = [order];
  const client = { query: async (sql, values) => {
    if (sql.startsWith('SELECT COUNT')) return { rows: [{ total: 0 }] };
    if (sql.startsWith('INSERT')) inserts.push(JSON.parse(values[0]));
    return { rows: [] };
  }, release() {} };
  const processState = { argv: ['node', 'restore-data.js', 'backup.json'], env: { DATABASE_URL: 'test' } };
  await vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../scripts/restore-data.js'), 'utf8'), {
    process: processState, console: { log() {}, error() {} },
    require: name => {
      if (name === 'dotenv') return { config() {} };
      if (name === 'node:fs') return { readFileSync: () => JSON.stringify(snapshot) };
      if (name === './database-tools') return { tables };
      if (name === '../src/database/db') return { connect: async () => client, end: async () => {} };
      throw new Error(name);
    },
  });
  assert.notEqual(processState.exitCode, 1);
  return inserts[0];
}
test('pipa backups from before quotes restore with defaults instead of NULL required fields', async () => {
  const row = await restore({ id: 1, usuario_id: 7, estado: 'solicitada' });
  assert.equal(row.cotizacion_version, 0); assert.equal(row.cotizacion_notas, '');
  assert.equal(row.usuario_id, 7);
});
test('restoring a current pipa backup preserves accepted price and quote version', async () => {
  const row = await restore({ id: 1, precio_centavos: 120050, cotizacion_version: 2, cotizacion_notas: 'Incluye traslado', precio_aceptado_en: '2026-10-07T10:00:00Z' });
  assert.equal(row.precio_centavos, 120050); assert.equal(row.cotizacion_version, 2);
  assert.equal(row.cotizacion_notas, 'Incluye traslado'); assert.equal(row.precio_aceptado_en, '2026-10-07T10:00:00Z');
});
