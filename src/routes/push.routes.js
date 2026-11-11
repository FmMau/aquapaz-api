const express = require('express');
const allowedHosts = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com', 'web.push.apple.com', 'notify.windows.com'];
function validSubscription(value) {
  try {
    const endpoint = new URL(value.endpoint);
    return endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password && !endpoint.port
      && allowedHosts.some(host => endpoint.hostname === host || endpoint.hostname.endsWith('.' + host))
      && value.endpoint.length < 4096 && /^[A-Za-z0-9_-]{87}=$|^[A-Za-z0-9_-]{87}$/.test(value.keys?.p256dh)
      && /^[A-Za-z0-9_-]{22}(==)?$/.test(value.keys?.auth)
      && Buffer.from(value.keys.p256dh, 'base64url').length === 65
      && Buffer.from(value.keys.p256dh, 'base64url')[0] === 4;
  } catch { return false; }
}
function createRouter({ pool, auth, env = process.env }) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/public-key', (_req, res) => {
    if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) return res.status(503).json({ error: 'Push aún no está configurado en el servidor.' });
    res.json({ publicKey: env.VAPID_PUBLIC_KEY });
  });
  router.use(auth);
  router.post('/subscribe', async (req, res) => {
    if (!validSubscription(req.body)) return res.status(400).json({ error: 'Suscripción inválida.' });
    try {
      await pool.query(`INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth) VALUES($1,$2,$3,$4)
        ON CONFLICT(endpoint) DO UPDATE SET user_id=EXCLUDED.user_id,p256dh=EXCLUDED.p256dh,auth=EXCLUDED.auth`,
      [req.user.id, req.body.endpoint, req.body.keys.p256dh, req.body.keys.auth]);
      res.status(201).json({ success: true });
    } catch { res.status(503).json({ error: 'No se pudo guardar la suscripción.' }); }
  });
  router.post('/unsubscribe', async (req, res) => {
    if (typeof req.body.endpoint !== 'string') return res.status(400).json({ error: 'Endpoint inválido.' });
    try {
      await pool.query('DELETE FROM push_subscriptions WHERE endpoint=$1 AND user_id=$2', [req.body.endpoint, req.user.id]);
      res.json({ success: true });
    } catch { res.status(503).json({ error: 'No se pudo eliminar la suscripción.' }); }
  });
  return router;
}
module.exports = { createRouter, validSubscription };
