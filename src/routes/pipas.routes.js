const router = require('express').Router();
const pool = require('../database/db');
router.use(require('../middlewares/auth.middleware'));
const volumes = [5000, 10000, 20000];
const validId = value => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));
const text = (value, min, max) => typeof value === 'string' && value.trim().length >= min && value.trim().length <= max;
const phone = value => typeof value === 'string' && /^[+\d ()-]{10,20}$/.test(value) && value.replace(/\D/g, '').length >= 10;
const active = "estado NOT IN ('completada','cancelada')";
function fail(res, error) {
  console.error('Pipas failed:', error.code || error.name);
  if (error.code === '23505') return res.status(409).json({ error: 'Ya existe un pedido activo. Actualiza para consultarlo.' });
  return res.status(503).json({ error: 'El servicio de pipas no está disponible. Intenta más tarde.' });
}
const details = `SELECT p.*, CASE WHEN o.id IS NOT NULL THEN json_build_object(
  'nombre',o.nombre,'placas',o.placas,'telefono',o.telefono,'capacidad',o.capacidad) ELSE NULL END AS operador
  FROM pedidos_pipa p LEFT JOIN operadores_pipa o ON o.id=p.operador_id`;

router.get('/pedidos', async (req, res) => {
  try {
    res.json((await pool.query(`${details} WHERE p.usuario_id=$1 ORDER BY p.fecha DESC LIMIT 30`, [req.user.id])).rows);
  } catch (error) { fail(res, error); }
});

router.post('/pedidos', async (req, res) => {
  const b = req.body || {};
  if (!text(b.client_id, 8, 128) || !/^[a-zA-Z0-9_-]+$/.test(b.client_id) || !text(b.colonia, 2, 100)
    || !text(b.direccion, 5, 300) || !text(b.referencias ?? '', 0, 500) || !phone(b.telefono)
    || !volumes.includes(b.litros) || typeof b.latitud !== 'number' || !Number.isFinite(b.latitud) || Math.abs(b.latitud) > 90
    || typeof b.longitud !== 'number' || !Number.isFinite(b.longitud) || Math.abs(b.longitud) > 180) {
    return res.status(400).json({ error: 'Revisa la dirección, teléfono, litros y punto de entrega.' });
  }
  const fields = ['colonia', 'direccion', 'referencias', 'telefono', 'litros', 'latitud', 'longitud'];
  const values = fields.map(field => typeof b[field] === 'string' ? b[field].trim() : b[field] ?? '');
  try {
    const existing = await pool.query('SELECT * FROM pedidos_pipa WHERE usuario_id=$1 AND client_id=$2', [req.user.id, b.client_id]);
    if (existing.rows.length) {
      if (!fields.every((field, i) => existing.rows[0][field] === values[i])) return res.status(409).json({ error: 'La solicitud ya fue enviada con otros datos.' });
      return res.json(existing.rows[0]);
    }
    const result = await pool.query(`INSERT INTO pedidos_pipa
      (usuario_id,client_id,colonia,direccion,referencias,telefono,litros,latitud,longitud)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (usuario_id,client_id) DO NOTHING RETURNING *`,
    [req.user.id, b.client_id, ...values]);
    if (result.rows.length) return res.status(201).json(result.rows[0]);
    const replay = await pool.query('SELECT * FROM pedidos_pipa WHERE usuario_id=$1 AND client_id=$2', [req.user.id, b.client_id]);
    if (!replay.rows[0] || !fields.every((field, i) => replay.rows[0][field] === values[i])) return res.status(409).json({ error: 'La solicitud ya fue enviada con otros datos.' });
    res.json(replay.rows[0]);
  } catch (error) { fail(res, error); }
});

router.post('/pedidos/:id/cancelar', async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'Pedido inválido' });
  try {
    const result = await pool.query(`UPDATE pedidos_pipa SET estado='cancelada',actualizado=NOW()
      WHERE id=$1 AND usuario_id=$2 AND estado IN ('solicitada','asignada') RETURNING *`, [req.params.id, req.user.id]);
    if (!result.rows.length) return res.status(409).json({ error: 'El pedido no puede cancelarse. Actualiza su estado.' });
    res.json(result.rows[0]);
  } catch (error) { fail(res, error); }
});

router.get('/operador', async (req, res) => {
  try {
    const profile = (await pool.query('SELECT * FROM operadores_pipa WHERE usuario_id=$1', [req.user.id])).rows[0];
    const pedido = profile ? (await pool.query(`SELECT * FROM pedidos_pipa WHERE operador_id=$1 AND ${active} LIMIT 1`, [profile.id])).rows[0] : null;
    res.json({ perfil: profile || null, pedido: pedido || null });
  } catch (error) { fail(res, error); }
});

router.post('/operador', async (req, res) => {
  const b = req.body || {};
  if (!text(b.nombre, 3, 100) || !text(b.placas, 3, 20) || !phone(b.telefono) || !volumes.includes(b.capacidad)) {
    return res.status(400).json({ error: 'Revisa el nombre de la pipa, placas, teléfono y capacidad.' });
  }
  try {
    const result = await pool.query(`INSERT INTO operadores_pipa (usuario_id,nombre,placas,telefono,capacidad)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT (usuario_id) DO NOTHING RETURNING *`,
    [req.user.id, b.nombre.trim(), b.placas.trim().toUpperCase(), b.telefono.trim(), b.capacidad]);
    if (!result.rows.length) return res.status(409).json({ error: 'Ya tienes una pipa registrada.' });
    res.status(201).json(result.rows[0]);
  } catch (error) { fail(res, error); }
});

router.put('/operador/disponibilidad', async (req, res) => {
  if (typeof req.body?.disponible !== 'boolean') return res.status(400).json({ error: 'Disponibilidad inválida' });
  try {
    const result = await pool.query('UPDATE operadores_pipa SET disponible=$1 WHERE usuario_id=$2 RETURNING *', [req.body.disponible, req.user.id]);
    if (!result.rows.length) return res.status(403).json({ error: 'Registra tu pipa primero.' });
    res.json(result.rows[0]);
  } catch (error) { fail(res, error); }
});

// Before acceptance operators see volume/colony only, not delivery coordinates or contact data.
router.get('/disponibles', async (req, res) => {
  try {
    const profile = (await pool.query('SELECT * FROM operadores_pipa WHERE usuario_id=$1', [req.user.id])).rows[0];
    if (!profile) return res.status(403).json({ error: 'Registra tu pipa primero.' });
    if (!profile.disponible) return res.json([]);
    res.json((await pool.query(`SELECT id,colonia,litros,fecha FROM pedidos_pipa
      WHERE estado='solicitada' AND usuario_id<>$1 AND litros<=$2
        AND NOT EXISTS (SELECT 1 FROM pedidos_pipa WHERE operador_id=$3 AND ${active})
      ORDER BY fecha LIMIT 30`, [req.user.id, profile.capacidad, profile.id])).rows);
  } catch (error) { fail(res, error); }
});

router.post('/pedidos/:id/aceptar', async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'Pedido inválido' });
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const profile = (await client.query('SELECT * FROM operadores_pipa WHERE usuario_id=$1 FOR UPDATE', [req.user.id])).rows[0];
    if (!profile?.disponible) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Activa tu disponibilidad primero.' }); }
    const busy = await client.query(`SELECT id FROM pedidos_pipa WHERE operador_id=$1 AND ${active}`, [profile.id]);
    if (busy.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Termina tu entrega actual antes de aceptar otra.' }); }
    const result = await client.query(`UPDATE pedidos_pipa SET operador_id=$1,estado='asignada',actualizado=NOW()
      WHERE id=$2 AND estado='solicitada' AND usuario_id<>$3 AND litros<=$4 RETURNING *`,
    [profile.id, req.params.id, req.user.id, profile.capacidad]);
    if (!result.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Este pedido ya no está disponible.' }); }
    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (error) { if (client) await client.query('ROLLBACK').catch(() => {}); fail(res, error); }
  finally { client?.release(); }
});

router.put('/pedidos/:id/estado', async (req, res) => {
  const previous = { en_camino: 'asignada', en_sitio: 'en_camino', completada: 'en_sitio' };
  const estado = req.body?.estado;
  if (!validId(req.params.id) || !Object.hasOwn(previous, estado)) return res.status(400).json({ error: 'Cambio de estado inválido' });
  try {
    const result = await pool.query(`UPDATE pedidos_pipa SET estado=$1,actualizado=NOW()
      WHERE id=$2 AND estado=$3 AND operador_id IN (SELECT id FROM operadores_pipa WHERE usuario_id=$4) RETURNING *`,
    [estado, req.params.id, previous[estado], req.user.id]);
    if (!result.rows.length) return res.status(409).json({ error: 'No puedes cambiar este pedido. Actualiza su estado.' });
    res.json(result.rows[0]);
  } catch (error) { fail(res, error); }
});
module.exports = router;
