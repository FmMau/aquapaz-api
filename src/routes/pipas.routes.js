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
    const result = await pool.query(`UPDATE pedidos_pipa SET estado=$1,actualizado=NOW(),
      pipa_latitud=CASE WHEN $1='completada' THEN NULL ELSE pipa_latitud END,
      pipa_longitud=CASE WHEN $1='completada' THEN NULL ELSE pipa_longitud END,
      pipa_precision=CASE WHEN $1='completada' THEN NULL ELSE pipa_precision END,
      pipa_observada_en=CASE WHEN $1='completada' THEN NULL ELSE pipa_observada_en END,
      pipa_recibida_en=CASE WHEN $1='completada' THEN NULL ELSE pipa_recibida_en END
      WHERE id=$2 AND estado=$3 AND operador_id IN (SELECT id FROM operadores_pipa WHERE usuario_id=$4)
        AND ($1 <> 'en_camino' OR (precio_centavos IS NOT NULL AND precio_aceptado_en IS NOT NULL)) RETURNING *`,
    [estado, req.params.id, previous[estado], req.user.id]);
    if (!result.rows.length) return res.status(409).json({ error: 'No puedes cambiar este pedido. Para iniciar el viaje el cliente debe aceptar el precio.' });
    res.json(result.rows[0]);
  } catch (error) { fail(res, error); }
});

router.put('/pedidos/:id/cotizacion', async (req, res) => {
  const b = req.body || {};
  if (!validId(req.params.id) || !Number.isSafeInteger(b.precio_centavos) || b.precio_centavos < 1 || b.precio_centavos > 10000000
    || !Number.isSafeInteger(b.version) || b.version < 0 || !text(b.notas ?? '', 0, 500)
    || !Number.isInteger(b.llegada_estimada_minutos) || b.llegada_estimada_minutos < 1 || b.llegada_estimada_minutos > 1440) {
    return res.status(400).json({ error: 'Indica un precio total válido, tiempo estimado entre 1 y 1440 minutos y notas de hasta 500 caracteres.' });
  }
  const notas = (b.notas || '').trim();
  try {
    const result = await pool.query(`UPDATE pedidos_pipa SET precio_centavos=$1,llegada_estimada_minutos=$2,
      cotizacion_notas=$3,cotizacion_version=cotizacion_version+1,actualizado=NOW()
      WHERE id=$4 AND estado='asignada' AND precio_aceptado_en IS NULL AND cotizacion_version=$5
        AND operador_id IN (SELECT id FROM operadores_pipa WHERE usuario_id=$6) RETURNING *`,
    [b.precio_centavos, b.llegada_estimada_minutos, notas, req.params.id, b.version, req.user.id]);
    if (result.rows.length) return res.json(result.rows[0]);
    // A retry of a lost response must not publish a second quote version.
    const replay = (await pool.query(`SELECT * FROM pedidos_pipa WHERE id=$1
      AND operador_id IN (SELECT id FROM operadores_pipa WHERE usuario_id=$2)`, [req.params.id, req.user.id])).rows[0];
    if (replay?.estado === 'asignada' && replay.cotizacion_version === b.version + 1
      && replay.precio_centavos === b.precio_centavos && replay.llegada_estimada_minutos === b.llegada_estimada_minutos
      && replay.cotizacion_notas === notas) return res.json(replay);
    res.status(409).json({ error: 'La cotización cambió, ya fue aceptada o el pedido no te pertenece. Actualiza antes de cotizar.' });
  } catch (error) { fail(res, error); }
});

router.post('/pedidos/:id/aceptar-precio', async (req, res) => {
  const b = req.body || {};
  if (!validId(req.params.id) || !Number.isSafeInteger(b.version) || b.version < 1
    || !Number.isSafeInteger(b.precio_centavos) || b.precio_centavos < 1 || b.precio_centavos > 10000000) {
    return res.status(400).json({ error: 'Cotización inválida' });
  }
  try {
    const result = await pool.query(`UPDATE pedidos_pipa SET precio_aceptado_en=COALESCE(precio_aceptado_en,NOW()),actualizado=NOW()
      WHERE id=$1 AND usuario_id=$2 AND estado='asignada' AND cotizacion_version=$3 AND precio_centavos=$4 RETURNING *`,
    [req.params.id, req.user.id, b.version, b.precio_centavos]);
    if (!result.rows.length) return res.status(409).json({ error: 'El precio cambió o el pedido ya no está disponible. Actualiza y revisa la cotización.' });
    res.json(result.rows[0]);
  } catch (error) { fail(res, error); }
});

router.post('/pedidos/:id/rechazar-precio', async (req, res) => {
  const b = req.body || {};
  if (!validId(req.params.id) || !Number.isSafeInteger(b.version) || b.version < 1) return res.status(400).json({ error: 'Cotización inválida' });
  try {
    const result = await pool.query(`UPDATE pedidos_pipa SET estado='cancelada',actualizado=NOW()
      WHERE id=$1 AND usuario_id=$2 AND estado='asignada' AND precio_aceptado_en IS NULL
        AND cotizacion_version=$3 AND precio_centavos IS NOT NULL RETURNING *`, [req.params.id, req.user.id, b.version]);
    if (!result.rows.length) return res.status(409).json({ error: 'La cotización cambió o ya fue aceptada. Actualiza su estado.' });
    res.json(result.rows[0]);
  } catch (error) { fail(res, error); }
});
function locationResponse(order, accepted) {
  const visible = ['en_camino', 'en_sitio'].includes(order.estado) && order.pipa_latitud != null && order.pipa_longitud != null;
  return { estado: order.estado, hora_servidor: new Date().toISOString(), ...(accepted === undefined ? {} : { aceptada: accepted }),
    ubicacion: visible ? { latitud: order.pipa_latitud, longitud: order.pipa_longitud, precision: order.pipa_precision,
      observada_en: order.pipa_observada_en, recibida_en: order.pipa_recibida_en } : null };
}
router.get('/pedidos/:id/ubicacion', async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'Pedido inválido' });
  try {
    const result = await pool.query(`SELECT estado,pipa_latitud,pipa_longitud,pipa_precision,pipa_observada_en,pipa_recibida_en
      FROM pedidos_pipa WHERE id=$1 AND (usuario_id=$2 OR operador_id IN (SELECT id FROM operadores_pipa WHERE usuario_id=$2))`,
    [req.params.id, req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Pedido no disponible' });
    res.json(locationResponse(result.rows[0]));
  } catch (error) { fail(res, error); }
});
router.put('/pedidos/:id/ubicacion', async (req, res) => {
  const b = req.body || {};
  const now = Date.now();
  if (!validId(req.params.id) || typeof b.latitud !== 'number' || !Number.isFinite(b.latitud) || Math.abs(b.latitud) > 90
    || typeof b.longitud !== 'number' || !Number.isFinite(b.longitud) || Math.abs(b.longitud) > 180
    || (b.precision != null && (typeof b.precision !== 'number' || !Number.isFinite(b.precision) || b.precision < 0 || b.precision > 10000))
    || !Number.isSafeInteger(b.observada_en) || b.observada_en < now - 120000 || b.observada_en > now + 30000) {
    return res.status(400).json({ error: 'Ubicación inválida o antigua. Revisa el GPS y la hora de tu teléfono.' });
  }
  try {
    const result = await pool.query(`UPDATE pedidos_pipa SET pipa_latitud=$1,pipa_longitud=$2,pipa_precision=$3,
      pipa_observada_en=$4::timestamptz,pipa_recibida_en=NOW()
      WHERE id=$5 AND estado IN ('en_camino','en_sitio')
        AND operador_id IN (SELECT id FROM operadores_pipa WHERE usuario_id=$6)
        AND (pipa_observada_en IS NULL OR pipa_observada_en < $4::timestamptz) RETURNING *`,
    [b.latitud, b.longitud, b.precision ?? null, new Date(b.observada_en).toISOString(), req.params.id, req.user.id]);
    if (result.rows.length) return res.json(locationResponse(result.rows[0], true));
    const current = (await pool.query(`SELECT * FROM pedidos_pipa WHERE id=$1 AND estado IN ('en_camino','en_sitio')
      AND operador_id IN (SELECT id FROM operadores_pipa WHERE usuario_id=$2)`, [req.params.id, req.user.id])).rows[0];
    if (!current) return res.status(409).json({ error: 'Solo el operador asignado puede compartir ubicación durante la entrega.' });
    res.json(locationResponse(current, false));
  } catch (error) { fail(res, error); }
});
router.delete('/pedidos/:id/ubicacion', async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'Pedido inválido' });
  try {
    const result = await pool.query(`UPDATE pedidos_pipa SET pipa_latitud=NULL,pipa_longitud=NULL,pipa_precision=NULL,
      pipa_observada_en=NULL,pipa_recibida_en=NULL WHERE id=$1
      AND operador_id IN (SELECT id FROM operadores_pipa WHERE usuario_id=$2) RETURNING estado`, [req.params.id, req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Pedido no disponible' });
    res.json(locationResponse(result.rows[0]));
  } catch (error) { fail(res, error); }
});
module.exports = router;
