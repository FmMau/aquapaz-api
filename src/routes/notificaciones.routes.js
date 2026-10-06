const router = require('express').Router();
const pool = require('../database/db');
router.use(require('../middlewares/auth.middleware'));
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM notificaciones WHERE usuario_id = $1 ORDER BY fecha DESC', [req.user.id]);
    res.json(result.rows);
  } catch (error) { fail(res, error); }
});
router.post('/', (req, res) => res.status(403).json({ error: 'Operación no permitida' }));
for (const [action, assignment] of [['leida', 'leido = true'], ['confirmar', 'confirmada = true, leido = true']]) {
  router.put(`/:id/${action}`, async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'ID inválido' });
    try {
      const result = await pool.query(`UPDATE notificaciones SET ${assignment} WHERE id = $1 AND usuario_id = $2 RETURNING id`, [req.params.id, req.user.id]);
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
