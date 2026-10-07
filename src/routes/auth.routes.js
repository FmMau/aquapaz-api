const express = require('express');
const router = express.Router();
const pool = require('../database/db');

const normalizePushToken = (token) => {
  if (typeof token !== 'string') return null;

  const trimmedToken = token.trim();
  if (!/^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/.test(trimmedToken) || trimmedToken.length > 300) return null;

  return trimmedToken;
};

const authMiddleware = require('../middlewares/auth.middleware');

// GUARDAR PUSH TOKEN
router.post('/push-token', authMiddleware, async (req, res) => {
  let client;
  try {
    const pushToken = req.body.token ?? req.body.push_token ?? req.body.pushToken ?? null;
    const pushTokenToSave = normalizePushToken(pushToken);

    if (!pushTokenToSave) {
      return res.status(400).json({ error: 'Push token invalido' });
    }

    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(741327020)');
    await client.query('UPDATE usuarios SET push_token=NULL WHERE push_token=$1 AND id<>$2', [pushTokenToSave, req.user.id]);
    await client.query(
      'UPDATE usuarios SET push_token = $1 WHERE id = $2',
      [pushTokenToSave, req.user.id]
    );
    await client.query('COMMIT');

    res.json({ success: true });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Auth request failed:', error.code || error.name);
    res.status(500).json({ error: 'Error guardando push token' });
  } finally { client?.release(); }
});

router.delete('/push-token', authMiddleware, async (req, res) => {
  const token = normalizePushToken(req.body?.push_token);
  if (!token) return res.status(400).json({ error: 'Push token inválido' });
  try {
    await pool.query('UPDATE usuarios SET push_token=NULL WHERE id=$1 AND push_token=$2', [req.user.id, token]);
    res.json({ success: true });
  } catch (error) {
    console.error('Push token removal failed:', error.code || error.name);
    res.status(503).json({ error: 'No se pudo desactivar este dispositivo' });
  }
});

module.exports = router;
