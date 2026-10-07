const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshDatabase, schemaSql, tables } = require('../scripts/database-tools');

function fake() {
  const calls = [];
  return { calls, query: async (sql, args) => {
    calls.push(sql);
    if (sql.startsWith('SELECT to_regclass')) return { rows: [{ name: args[0] }] };
    if (sql.includes('to_jsonb')) return { rows: [{ row: { id: 7 } }] };
    if (sql.includes('last_value')) return { rows: [{ last_value: 7, is_called: true }] };
    return { rows: [] };
  } };
}
test('fresh backs up before dropping, preserves IDs, and commits atomically', async () => {
  const client = fake();
  const result = await freshDatabase(client, { sql: 'CREATE TABLE example (id int)', backup: snapshot => {
    assert.equal(snapshot.tables.usuarios[0].id, 7);
    assert.ok(!client.calls.some(sql => sql.startsWith('DROP')));
    return 'backup.json';
  } });
  assert.equal(result.removed.usuarios, 1);
  assert.ok(client.calls.includes('COMMIT'));
  assert.equal(client.calls.filter(sql => sql.includes('setval')).length, tables.length);
  assert.ok(!client.calls.some(sql => /CASCADE/.test(sql)));
});
test('backup failure aborts fresh before any DROP', async () => {
  const client = fake();
  await assert.rejects(freshDatabase(client, { backup: () => { throw new Error('Disk full'); } }));
  assert.ok(client.calls.includes('ROLLBACK'));
  assert.ok(!client.calls.some(sql => sql.startsWith('DROP')));
});
test('full schema is transaction-compatible and creates all application tables', () => {
  const sql = schemaSql();
  assert.ok(!/^\s*(BEGIN|COMMIT);/m.test(sql));
  for (const table of tables) assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS ' + table));
});
