const router = require('express').Router();
const pool = require('../database/db');
router.use(require('../middlewares/auth.middleware'));
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`SELECT n.id,n.mensaje,n.tipo,n.leido,n.confirmada,
      to_char(n.fecha, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS fecha,
      n.pedido_id,n.evento,n.destinatario,n.titulo,n.reporte_id,
      CASE WHEN r.colonia=u.colonia THEN r.estado END AS reporte_estado,
      CASE WHEN r.colonia=u.colonia THEN r.tipo END AS reporte_tipo,
      CASE WHEN r.colonia=u.colonia THEN r.colonia END AS reporte_colonia,
      c.decision AS mi_decision,
      (n.tipo='reporte' AND r.id IS NOT NULL AND r.colonia=u.colonia
        AND r.usuario_id<>u.id AND c.id IS NULL) AS puede_confirmar
      FROM notificaciones n JOIN usuarios u ON u.id=n.usuario_id
      LEFT JOIN reportes r ON r.id=n.reporte_id
      LEFT JOIN confirmaciones c ON c.reporte_id=r.id AND c.usuario_id=u.id
      WHERE n.usuario_id = $1 ORDER BY n.id DESC LIMIT 200`, [req.user.id]);
    res.json(result.rows);
  } catch (error) { fail(res, error); }
});
router.post('/', (req, res) => res.status(403).json({ error: 'Operación no permitida' }));
for (const [action, assignment] of [['leida', 'leido = true'], ['confirmar', 'confirmada = true, leido = true']]) {
  router.put(`/:id/${action}`, async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'ID inválido' });
    try {
      const result = await pool.query(`UPDATE notificaciones SET ${assignment} WHERE id = $1 AND usuario_id = $2
        ${action === 'confirmar' ? "AND tipo <> 'pipa' AND reporte_id IS NULL" : ''} RETURNING id`, [req.params.id, req.user.id]);
      if (!result.rows.length) return res.status(404).json({ error: 'Notificación no encontrada' });
      res.json({ success: true });
    } catch (error) { fail(res, error); }
  });
}
router.delete('/:id', async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'ID inválido' });
  try {
    const result = await pool.query('DELETE FROM notificaciones WHERE id = $1 AND usuario_id = $2 RETURNING id', [req.params.id, req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Notificación no encontrada' });
    res.json({ success: true });
  } catch (error) { fail(res, error); }
});
function validId(value) { return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)); }
function fail(res, error) {
  console.error('Notification request failed:', error.code || error.name);
  res.status(500).json({ error: 'Error procesando notificación' });
}
module.exports = router;
