require('dotenv').config({ quiet: true });
const pool = require('../src/database/db');
const { freshDatabase } = require('./database-tools');

(async () => {
  let client;
  try {
    if (!process.argv.includes('--force')) throw Object.assign(new Error(), { code: 'REQUIRES_FORCE' });
    if (!process.env.DATABASE_URL) throw Object.assign(new Error(), { code: 'MISSING_DATABASE_URL' });
    client = await pool.connect();
    const result = await freshDatabase(client);
    console.log(JSON.stringify({ freshComplete: true, ...result }));
  } catch (error) {
    console.error('Fresh migration failed:', error.code || error.name);
    if (error.code === 'REQUIRES_FORCE') console.error('Deletes application data. Run: npm run migrate:fresh -- --force');
    process.exitCode = 1;
  } finally {
    client?.release();
    await pool.end();
  }
})();
