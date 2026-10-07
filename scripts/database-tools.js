const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const tables = ['usuarios', 'reportes', 'confirmaciones', 'notificaciones', 'operadores_pipa', 'pedidos_pipa'];

function schemaSql() {
  return ['000_base_schema.sql', '001_sync_and_ownership.sql', '002_pipas.sql'].map(file =>
    fs.readFileSync(path.join(__dirname, '../migrations', file), 'utf8')
      .replace(/^\s*(BEGIN|COMMIT);\s*$/gm, '')
  ).join('\n');
}

function saveBackup(snapshot) {
  const directory = path.join(__dirname, '../backups');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `before-fresh-${Date.now()}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), { flag: 'wx', mode: 0o600 });
  // Verify persistence before any destructive operation.
  if (fs.readFileSync(file, 'utf8') !== JSON.stringify(snapshot, null, 2)) throw new Error('Backup verification failed');
  return file;
}

async function freshDatabase(client, { backup = saveBackup, sql = schemaSql() } = {}) {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query('SET LOCAL search_path = public');
    const snapshot = { format: 'aquapaz-data-v1', createdAt: new Date().toISOString(), tables: {}, sequences: {} };
    for (const table of tables) {
      const exists = await client.query('SELECT to_regclass($1) AS name', ['public.' + table]);
      if (!exists.rows[0].name) { snapshot.tables[table] = []; continue; }
      await client.query(`LOCK TABLE "${table}" IN ACCESS EXCLUSIVE MODE`);
      // JSON conversion in PostgreSQL preserves timestamps without JS timezone conversion.
      snapshot.tables[table] = (await client.query(`SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY id`)).rows.map(row => row.row);
      const sequence = await client.query(`SELECT last_value, is_called FROM "${table}_id_seq"`);
      snapshot.sequences[table] = sequence.rows[0];
    }
    snapshot.columns = (await client.query("SELECT table_name, column_name, data_type, column_default, is_nullable FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position")).rows;
    const file = await backup(snapshot);
    // No CASCADE: an unexpected external dependency aborts the transaction.
    await client.query('DROP TABLE IF EXISTS public.pedidos_pipa, public.operadores_pipa, public.notificaciones, public.confirmaciones, public.reportes, public.usuarios');
    await client.query(sql);
    // Never reuse old IDs: cached reports and old JWTs must not target new records.
    for (const table of tables) {
      const sequence = snapshot.sequences[table];
      if (sequence) await client.query('SELECT setval(pg_get_serial_sequence($1, $2), $3, $4)', ['public.' + table, 'id', sequence.last_value, sequence.is_called]);
    }
    await client.query('COMMIT');
    return { backup: file, removed: Object.fromEntries(tables.map(table => [table, snapshot.tables[table].length])) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

module.exports = { tables, schemaSql, freshDatabase };
