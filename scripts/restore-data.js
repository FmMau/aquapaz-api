require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const pool = require('../src/database/db');
const { tables } = require('./database-tools');

(async () => {
  let client;
  try {
    const file = process.argv[2];
    if (!file) throw Object.assign(new Error(), { code: 'BACKUP_PATH_REQUIRED' });
    const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (snapshot.format !== 'aquapaz-data-v1' || !tables.every(table => Array.isArray(snapshot.tables?.[table]))) throw Object.assign(new Error(), { code: 'INVALID_BACKUP' });
    if (!process.env.DATABASE_URL) throw Object.assign(new Error(), { code: 'MISSING_DATABASE_URL' });
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('SET LOCAL search_path = public');
    await client.query('LOCK TABLE usuarios, reportes, confirmaciones, notificaciones IN ACCESS EXCLUSIVE MODE');
    for (const table of tables) {
      const count = await client.query(`SELECT COUNT(*)::int AS total FROM "${table}"`);
      if (count.rows[0].total !== 0) throw Object.assign(new Error(), { code: 'RESTORE_REQUIRES_EMPTY_TABLES' });
    }
    for (const table of tables) {
      for (const row of snapshot.tables[table]) {
        await client.query(`INSERT INTO "${table}" SELECT * FROM json_populate_record(NULL::"${table}", $1::json)`, [JSON.stringify(row)]);
      }
      const sequence = snapshot.sequences[table];
      if (sequence) await client.query('SELECT setval(pg_get_serial_sequence($1, $2), $3, $4)', ['public.' + table, 'id', sequence.last_value, sequence.is_called]);
    }
    await client.query('COMMIT');
    console.log('Backup restored');
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Restore failed:', error.code || error.name);
    process.exitCode = 1;
  } finally { client?.release(); await pool.end(); }
})();
