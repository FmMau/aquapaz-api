const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD || undefined,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
});

pool.connect()
  .then(() => {
    console.log('PostgreSQL conectado');
  })
  .catch((err) => {
    console.log('Error PostgreSQL:', err);
  });

module.exports = pool;