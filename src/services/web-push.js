function createWebPushWorker({ pool, env = process.env, sender, logger = console }) {
  let running = false;
  let configured = false;
  async function tick() {
    if (running || !env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) return;
    running = true;
    try {
      sender ||= require('web-push');
      if (!configured) {
        if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(env.VAPID_SUBJECT)) throw new Error('Invalid VAPID_SUBJECT');
        sender.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
        configured = true;
      }
      const { rows } = await pool.query(`WITH ready AS (
        SELECT id FROM web_push_deliveries WHERE state IN ('pending','sending') AND next_at<=NOW()
        ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 10
      ), claimed AS (
        UPDATE web_push_deliveries d SET state='sending',attempts=attempts+1,next_at=NOW()+INTERVAL '5 minutes'
        FROM ready WHERE d.id=ready.id RETURNING d.*
      ) SELECT d.*,s.endpoint,s.p256dh,s.auth,n.titulo,n.mensaje,n.evento,n.reporte_id,
        EXTRACT(EPOCH FROM (d.expires_at-NOW())) AS ttl,
        CASE WHEN n.evento LIKE 'oferta:%' THEN EXISTS (
          SELECT 1 FROM pipa_ofertas f JOIN operadores_pipa o ON o.id=f.operador_id
          JOIN pedidos_pipa p ON p.id=f.pedido_id
          WHERE ('oferta:'||f.id)=n.evento AND f.pedido_id=n.pedido_id AND o.usuario_id=n.usuario_id
            AND f.estado='pendiente' AND f.vence_en>NOW() AND p.estado='solicitada'
        ) ELSE true END AS live
      FROM claimed d JOIN push_subscriptions s ON s.id=d.subscription_id
      JOIN notificaciones n ON n.id=d.notification_id AND n.usuario_id=s.user_id`);
      for (const row of rows) {
        let state = 'sent', delay = 0;
        try {
          if (Number(row.ttl) <= 0 || !row.live) state = 'expired';
          else await sender.sendNotification({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
            JSON.stringify({ title: row.titulo || 'AquaPaz', body: row.mensaje, url: row.reporte_id ? `#/notificaciones?reporte=${row.reporte_id}` : '#/notificaciones', tag: `aquapaz-${row.notification_id}` }),
            { TTL: Math.max(1, Math.floor(Number(row.ttl))), timeout: 10000 });
        } catch (error) {
          if ([404,410].includes(error.statusCode)) {
            await pool.query('DELETE FROM push_subscriptions WHERE id=$1 AND endpoint=$2', [row.subscription_id, row.endpoint]);
            continue;
          }
          const retryable = !error.statusCode || error.statusCode === 429 || error.statusCode >= 500;
          state = retryable && row.attempts < 8 ? 'pending' : 'failed';
          const retryAfter = Number(error.headers?.['retry-after']);
          delay = Math.min(3600, Math.max(30 * 2 ** Math.min(row.attempts, 7), Number.isFinite(retryAfter) ? retryAfter : 0));
          logger.warn('Web push delivery failed:', error.statusCode || error.code || error.name);
        }
        await pool.query("UPDATE web_push_deliveries SET state=$1,next_at=NOW()+($2 * INTERVAL '1 second') WHERE id=$3 AND state='sending'", [state, delay, row.id]);
      }
    } catch (error) { logger.error('Web push worker failed:', error.code || error.name); }
    finally { running = false; }
  }
  return { tick };
}
module.exports = { createWebPushWorker };
