const router = require('express').Router();
const pool = require('../database/db');
const colonies = new Set(require('../data/colonias.json'));
const { profileFieldErrors } = require('../services/form-validation');
router.use(require('../middlewares/auth.middleware'));

router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, nombre, email, telefono, colonia FROM usuarios WHERE id=$1', [req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Cuenta no encontrada' });
    res.json({ user: result.rows[0] });
  } catch {
    res.status(503).json({ error: 'No pudimos consultar tu perfil' });
  }
});

router.put('/', async (req, res) => {
  const body = req.body;
  if (!body || Array.isArray(body) || Object.keys(body).some(key => !['nombre', 'telefono', 'colonia'].includes(key)) ||
      typeof body !== 'object') {
    return res.status(400).json({ error: 'Envía nombre, teléfono y colonia' });
  }
  const fields=profileFieldErrors(body,Array.from(colonies));
  if(Object.keys(fields).length)return res.status(400).json({error:'Revisa los campos del perfil.',fields});
  const nombre = body.nombre.trim(), telefono = body.telefono.trim(), colonia = body.colonia.trim();
  try {
    const result = await pool.query(
      'UPDATE usuarios SET nombre=$1, telefono=$2, colonia=$3 WHERE id=$4 RETURNING id, nombre, email, telefono, colonia',
      [nombre, telefono, colonia, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Cuenta no encontrada' });
    res.json({ user: result.rows[0] });
  } catch {
    res.status(503).json({ error: 'No pudimos guardar tu perfil. Consulta de nuevo antes de reintentar' });
  }
});
module.exports = router;
