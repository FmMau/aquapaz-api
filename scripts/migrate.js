require('dotenv').config({ quiet: true });
const { schemaSql } = require('./database-tools');
const pool = require('../src/database/db');

(async () => {
  let client;
  try {
    if (!process.env.DATABASE_URL) throw Object.assign(new Error(), { code: 'MISSING_DATABASE_URL' });
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SET LOCAL search_path = public');
    await client.query(schemaSql());
    await client.query('COMMIT');
    console.log('Migration complete');
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Migration failed:', error.code || error.name);
    process.exitCode = 1;
  } finally {
    client?.release();
    await pool.end();
  }
})();
