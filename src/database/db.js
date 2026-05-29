const { Pool } = require('pg');

const pool = new Pool({

  connectionString:
    process.env.DATABASE_URL,

  ssl: {
    rejectUnauthorized: false,
  },

});

module.exports = pool;
pool.connect()
  .then(() => {
    console.log('PostgreSQL conectado');
  })
  .catch((err) => {
    console.log('Error PostgreSQL:', err);
  });

module.exports = pool;