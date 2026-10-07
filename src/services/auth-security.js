const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { authError, publicUser } = require('./auth-validation');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const random = () => crypto.randomBytes(32).toString('base64url');
const challenge = value => crypto.createHash('sha256').update(value).digest('base64url');
let lastCleanup = 0;
async function transaction(pool, operation) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); await client.query("SET LOCAL lock_timeout='5s'"); await client.query("SET LOCAL statement_timeout='15s'"); const result = await operation(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
function issueSession(user) {
  return { user: publicUser(user), token: jwt.sign({ id: user.id, v: user.auth_version || 0 }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: process.env.JWT_EXPIRES_IN || '1h' }) };
}
async function limit(pool, purpose, key, maximum, minutes) {
  if (Date.now() - lastCleanup > 60000) {
    lastCleanup = Date.now();
    await pool.query('DELETE FROM auth_limits WHERE expires_at<=NOW(); DELETE FROM auth_flows WHERE expires_at<=NOW(); DELETE FROM auth_tickets WHERE expires_at<=NOW(); DELETE FROM auth_resets WHERE expires_at<=NOW()');
  }
  const keyHash = digest(`${purpose}:${key}`);
  const { rows } = await pool.query(`INSERT INTO auth_limits (key_hash,hits,expires_at) VALUES ($1,1,NOW()+$2*INTERVAL '1 minute')
    ON CONFLICT(key_hash) DO UPDATE SET hits=CASE WHEN auth_limits.expires_at<=NOW() THEN 1 ELSE auth_limits.hits+1 END,
    expires_at=CASE WHEN auth_limits.expires_at<=NOW() THEN EXCLUDED.expires_at ELSE auth_limits.expires_at END RETURNING hits`, [keyHash, minutes]);
  if (rows[0].hits > maximum) throw authError(429, 'Demasiados intentos. Espera unos minutos antes de volver a intentar.');
}
const emailLock = (client, email) => client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,741327021))', [email]);
module.exports = { digest, random, challenge, transaction, issueSession, limit, emailLock };
