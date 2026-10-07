const express = require('express');
const router = express.Router();
const pool = require('../database/db');
router.use(require('../middlewares/auth.middleware'));
const validId = value => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

const enviarPushAColonia = async (colonia, usuarioIdExcluir, titulo, mensaje, reporte_id = null) => {
  try {
    const result = await pool.query(
      `SELECT id, email, colonia, push_token FROM usuarios
       WHERE colonia = $1 AND id != $2 AND push_token IS NOT NULL`,
      [colonia, usuarioIdExcluir]
    );

    const recipients = result.rows.filter(r => typeof r.push_token === 'string' && /^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/.test(r.push_token));
    const tokens = recipients.map(r => r.push_token);

    if (tokens.length === 0) {
      return { sent: false, totalTokens: 0, expoResult: null };
    }

    const expoResponse = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        recipients.map((recipient) => ({
          to: recipient.push_token,
          title: titulo,
          body: mensaje,
          sound: 'default',
          data: { tipo: 'reporte', reporte_id, usuario_id: recipient.id },
        }))
      ),
    });

    const expoResult = await expoResponse.json();
    const tickets = Array.isArray(expoResult.data) ? expoResult.data : [];
    return { sent: expoResponse.ok && tickets.length === tokens.length && tickets.every(t => t.status === 'ok'), totalTokens: tokens.length };
  } catch (error) {
    console.error('Push failed:', error.code || error.name);
    return { sent: false, totalTokens: 0, error: 'Push no disponible' };
  }
};


router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM reportes WHERE colonia = $1 ORDER BY fecha DESC', [req.user.colonia]);
    res.json(result.rows);
  } catch (error) { fail(res, error); }
});

// City map exposes aggregates only, never identities or comments.
router.get('/mapa', async (req, res) => {
  try {
    const result = await pool.query(`
      WITH ultimos AS (
        SELECT DISTINCT ON (colonia, usuario_id) colonia, estado, fecha
        FROM reportes
        WHERE tipo = 'agua' AND usuario_id IS NOT NULL
          AND fecha >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '24 hours'
          AND fecha <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
          AND estado IN ('no_agua', 'baja_presion', 'tengo_agua')
        ORDER BY colonia, usuario_id, fecha DESC, id DESC
      )
      SELECT colonia,
        COUNT(*) FILTER (WHERE estado = 'no_agua')::int AS no_agua,
        COUNT(*) FILTER (WHERE estado = 'baja_presion')::int AS baja_presion,
        COUNT(*) FILTER (WHERE estado = 'tengo_agua')::int AS tengo_agua,
        to_char(MAX(fecha), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ultima_actualizacion,
        to_char(MIN(fecha) + INTERVAL '24 hours', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expira
      FROM ultimos GROUP BY colonia ORDER BY colonia
    `);
    res.json({ colonias: result.rows, actualizado: new Date().toISOString(), ventana_horas: 24 });
  } catch (error) { fail(res, error); }
});

router.get('/colonia/:colonia', async (req, res) => {
  if (req.params.colonia !== req.user.colonia) return res.status(403).json({ error: 'Colonia no autorizada' });
  try {
    const result = await pool.query("SELECT * FROM reportes WHERE colonia = $1 AND tipo = 'agua' AND estado = 'no_agua' ORDER BY fecha DESC LIMIT 20", [req.user.colonia]);
    res.json(result.rows);
  } catch (error) { fail(res, error); }
});

router.post('/', async (req, res) => {
  const { tipo, estado, comentario = '', client_id, colonia } = req.body;
  if (!['agua', 'fuga'].includes(tipo) || !['no_agua', 'baja_presion', 'tengo_agua'].includes(estado) || typeof comentario !== 'string' || comentario.length > 2000 || typeof client_id !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(client_id)) {
    return res.status(400).json({ error: 'Reporte inválido; client_id es obligatorio' });
  }
  if (colonia !== req.user.colonia) return res.status(403).json({ error: 'Colonia no autorizada' });
  try {
    const result = await pool.query(
      'INSERT INTO reportes (colonia, tipo, estado, comentario, usuario_id, client_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (usuario_id, client_id) WHERE client_id IS NOT NULL DO NOTHING RETURNING *',
      [req.user.colonia, tipo, estado, comentario, req.user.id, client_id]
    );
    if (!result.rows.length) {
      const existing = await pool.query('SELECT * FROM reportes WHERE usuario_id = $1 AND client_id = $2', [req.user.id, client_id]);
      const report = existing.rows[0];
      if (!report || report.tipo !== tipo || report.estado !== estado || report.comentario !== comentario || report.colonia !== colonia) return res.status(409).json({ error: 'client_id ya utilizado para otro reporte' });
      return res.json({ ...report, replayed: true });
    }
    const reporte = result.rows[0];
    const texto = { no_agua: 'sin agua', baja_presion: 'con baja presión', tengo_agua: 'con agua normal' }[estado];
    const push = await enviarPushAColonia(req.user.colonia, req.user.id, 'Reporte en ' + req.user.colonia, 'Un vecino reporta ' + texto + '. ¿Confirmas?', reporte.id);
    res.status(201).json({ ...reporte, push });
  } catch (error) { fail(res, error); }
});

router.post('/:id/confirmar', async (req, res) => {
  const { id } = req.params;
  const { decision } = req.body;
  if (!validId(id) || !['confirmar', 'rechazar'].includes(decision)) return res.status(400).json({ error: 'Confirmación inválida' });
  let client;
  let committed = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // Serialize confirmations for this report, including concurrent retries.
    const reportResult = await client.query('SELECT * FROM reportes WHERE id = $1 FOR UPDATE', [id]);
    const reporte = reportResult.rows[0];
    if (!reporte || reporte.colonia !== req.user.colonia) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Reporte no encontrado' });
    }
    if (reporte.usuario_id === req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'No puedes confirmar tu propio reporte' });
    }
    const before = await client.query("SELECT COUNT(DISTINCT usuario_id)::int AS total FROM confirmaciones WHERE reporte_id = $1 AND decision = 'confirmar'", [id]);
    const existing = await client.query('SELECT decision FROM confirmaciones WHERE reporte_id = $1 AND usuario_id = $2', [id, req.user.id]);
    if (existing.rows.length && existing.rows[0].decision !== decision) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Ya registraste otra decisión' });
    }
    if (!existing.rows.length) await client.query('INSERT INTO confirmaciones (reporte_id, decision, usuario_id) VALUES ($1,$2,$3)', [id, decision, req.user.id]);
    const count = await client.query("SELECT COUNT(DISTINCT usuario_id)::int AS total FROM confirmaciones WHERE reporte_id = $1 AND decision = 'confirmar'", [id]);
    const total = Number(count.rows[0].total);
    await client.query('COMMIT');
    committed = true;
    if (Number(before.rows[0].total) < 3 && total >= 3) {
      await enviarPushAColonia(reporte.colonia, -1, 'Reporte validado por la comunidad', total + ' vecinos confirmaron el reporte en ' + reporte.colonia, Number(id));
    }
    res.json({ success: true, confirmaciones: total, consenso: total >= 3 });
  } catch (error) {
    if (client && !committed) await client.query('ROLLBACK').catch(() => {});
    fail(res, error);
  } finally { client?.release(); }
});

function fail(res, error) {
  console.error('Report request failed:', error.code || error.name);
  res.status(500).json({ error: 'Error procesando reporte' });
}
module.exports = router;
