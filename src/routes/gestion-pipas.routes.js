const router = require('express').Router();
const pool = require('../database/db');

router.use(require('../middlewares/auth.middleware'));

const states = [
  'solicitada',
  'asignada',
  'en_camino',
  'en_sitio',
  'completada',
  'cancelada',
];

const validId = (value) => (
  /^[1-9]\d*$/.test(String(value))
  && Number.isSafeInteger(Number(value))
);

const orderFields = `
  p.id, p.usuario_id, p.colonia, p.litros, p.estado,
  p.operador_id, p.fecha, p.actualizado, p.gestion_version,
  p.precio_centavos, p.precio_aceptado_en,
  o.nombre AS pipa_nombre, o.placas AS pipa_placas,
  u.nombre AS operador_nombre
`;

const orderJoin = `
  FROM pedidos_pipa p
  LEFT JOIN operadores_pipa o ON o.id = p.operador_id
  LEFT JOIN usuarios u ON u.id = o.usuario_id
`;

const fleetFields = `
  SELECT o.id, o.nombre, o.placas, o.capacidad, o.disponible,
    o.usuario_id, u.nombre AS operador_nombre,
    job.id AS pedido_activo_id
  FROM operadores_pipa o
  JOIN usuarios u ON u.id = o.usuario_id
  LEFT JOIN pedidos_pipa job ON job.operador_id = o.id
    AND job.estado NOT IN ('completada', 'cancelada')
`;

function fail(res, error) {
  console.error('Pipa management failed:', error.code || error.name);

  if (error.code === '23505' || error.code === '40P01') {
    return res.status(409).json({
      error: 'La asignación cambió. Actualiza el pedido y las pipas disponibles.',
    });
  }

  return res.status(503).json({
    error: 'La gestión de pipas no está disponible. Intenta de nuevo.',
  });
}

router.use(async (req, res, next) => {
  res.set('Cache-Control', 'no-store');

  try {
    const result = await pool.query(
      'SELECT rol FROM gestion_roles WHERE usuario_id = $1',
      [req.user.id],
    );
    const role = result.rows[0]?.rol;

    if (!['gestor', 'consulta'].includes(role)) {
      return res.status(403).json({
        error: 'Tu cuenta no tiene acceso a la gestión de pipas.',
      });
    }

    req.gestionRole = role;
    next();
  } catch (error) {
    fail(res, error);
  }
});

router.get('/contexto', async (req, res) => {
  try {
    const colonies = await pool.query(`
      SELECT DISTINCT colonia
      FROM pedidos_pipa
      ORDER BY colonia
    `);
    const fleet = await pool.query(`
      ${fleetFields}
      ORDER BY o.nombre, o.id
    `);

    res.json({
      permisos: {
        consultar: true,
        gestionar: req.gestionRole === 'gestor',
      },
      colonias: colonies.rows.map((row) => row.colonia),
      pipas: fleet.rows,
    });
  } catch (error) {
    fail(res, error);
  }
});

router.get('/pedidos', async (req, res) => {
  const allowed = ['q', 'estado', 'colonia', 'operador_id', 'pagina'];
  const query = req.query;
  const values = [];
  const conditions = [];

  function add(condition, value) {
    values.push(value);
    conditions.push(condition.replace('?', `$${values.length}`));
  }

  function invalid() {
    return res.status(400).json({ error: 'Filtros de pedidos inválidos.' });
  }

  if (
    Object.keys(query).some((key) => !allowed.includes(key))
    || Object.values(query).some((value) => typeof value !== 'string')
  ) {
    return invalid();
  }

  if (query.q) {
    if (query.q.length > 100) return invalid();

    add(`
      position(lower(?) in lower(concat_ws(
        ' ', p.id::text, p.colonia, o.nombre, o.placas, u.nombre
      ))) > 0
    `, query.q.trim());
  }

  if (query.estado === 'activos') {
    conditions.push("p.estado NOT IN ('completada', 'cancelada')");
  } else if (query.estado) {
    if (!states.includes(query.estado)) return invalid();
    add('p.estado = ?', query.estado);
  }

  if (query.colonia) {
    if (query.colonia.length > 100) return invalid();
    add('p.colonia = ?', query.colonia);
  }

  if (query.operador_id === 'sin_asignar') {
    conditions.push('p.operador_id IS NULL');
  } else if (query.operador_id) {
    if (!validId(query.operador_id)) return invalid();
    add('p.operador_id = ?', Number(query.operador_id));
  }

  if (query.pagina && !validId(query.pagina)) return invalid();

  const page = Number(query.pagina || 1);
  const limit = 20;

  if (page > 100000) return invalid();

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const counts = await pool.query(`
      SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE p.estado = 'solicitada')::int AS pendientes,
        COUNT(*) FILTER (WHERE p.estado = 'asignada')::int AS asignadas,
        COUNT(*) FILTER (
          WHERE p.estado IN ('en_camino', 'en_sitio')
        )::int AS en_entrega,
        COUNT(*) FILTER (WHERE p.estado = 'completada')::int AS completadas
      ${orderJoin}
      ${where}
    `, values);

    const orders = await pool.query(`
      SELECT ${orderFields}
      ${orderJoin}
      ${where}
      ORDER BY p.fecha DESC, p.id DESC
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}
    `, [...values, limit, (page - 1) * limit]);

    res.json({
      pedidos: orders.rows,
      resumen: counts.rows[0],
      pagina: page,
      limite: limit,
    });
  } catch (error) {
    fail(res, error);
  }
});

router.get('/pedidos/:id', async (req, res) => {
  if (!validId(req.params.id)) {
    return res.status(400).json({ error: 'Folio inválido.' });
  }

  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');

    const order = (await client.query(`
      SELECT ${orderFields}, p.direccion, p.referencias, p.telefono,
        p.latitud, p.longitud, p.cotizacion_version,
        p.cotizacion_notas, p.llegada_estimada_minutos,
        o.telefono AS operador_telefono, o.capacidad,
        p.pipa_latitud, p.pipa_longitud, p.pipa_precision,
        p.pipa_observada_en, p.pipa_recibida_en
      ${orderJoin}
      WHERE p.id = $1
    `, [req.params.id])).rows[0];

    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pedido no encontrado.' });
    }

    // Only these candidates may be selected; assignment rechecks under locks.
    const candidates = await client.query(`
      ${fleetFields}
      WHERE o.disponible
        AND o.capacidad >= $1
        AND o.usuario_id <> $2
        AND job.id IS NULL
      ORDER BY o.capacidad, o.nombre, o.id
    `, [order.litros, order.usuario_id]);

    const history = await client.query(`
      SELECT h.id, h.accion, h.estado, h.nota, h.version, h.fecha,
        h.actor_id, actor.nombre AS actor_nombre,
        h.operador_id, o.nombre AS pipa_nombre
      FROM pipa_gestion_historial h
      JOIN usuarios actor ON actor.id = h.actor_id
      LEFT JOIN operadores_pipa o ON o.id = h.operador_id
      WHERE h.pedido_id = $1
      ORDER BY h.version DESC
    `, [req.params.id]);

    await client.query('COMMIT');

    const positionVisible = (
      ['en_camino', 'en_sitio'].includes(order.estado)
      && order.pipa_latitud !== null
      && order.pipa_longitud !== null
    );

    const visibleOrder = { ...order };

    for (const field of [
      'pipa_latitud', 'pipa_longitud', 'pipa_precision',
      'pipa_observada_en', 'pipa_recibida_en',
    ]) {
      delete visibleOrder[field];
    }

    res.json({
      pedido: visibleOrder,
      pipas_disponibles: order.estado === 'solicitada' ? candidates.rows : [],
      historial: history.rows,
      ubicacion: positionVisible ? {
        latitud: order.pipa_latitud,
        longitud: order.pipa_longitud,
        precision: order.pipa_precision,
        observada_en: order.pipa_observada_en,
        recibida_en: order.pipa_recibida_en,
      } : null,
      hora_servidor: new Date().toISOString(),
    });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    fail(res, error);
  } finally {
    client?.release();
  }
});

router.post('/pedidos/:id/seguimiento', async (req, res) => {
  if (req.gestionRole !== 'gestor') {
    return res.status(403).json({ error: 'Tu cuenta tiene acceso de consulta.' });
  }

  const body = req.body || {};
  const allowed = ['accion', 'operador_id', 'version', 'nota'];
  const validNote = (
    typeof body.nota === 'string'
    && body.nota.trim().length > 0
    && body.nota.length <= 2000
  );
  const assignment = body.accion === 'asignacion';

  if (
    !validId(req.params.id)
    || !['asignacion', 'nota'].includes(body.accion)
    || !Number.isSafeInteger(body.version)
    || body.version < 0
    || !validNote
    || Object.keys(body).some((key) => !allowed.includes(key))
    || (assignment && (!Number.isSafeInteger(body.operador_id) || body.operador_id <= 0))
    || (!assignment && body.operador_id !== undefined)
  ) {
    return res.status(400).json({ error: 'Revisa la acción, versión, pipa y nota.' });
  }

  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    async function abort(status, message) {
      await client.query('ROLLBACK');
      return res.status(status).json({ error: message });
    }

    const permission = (await client.query(`
      SELECT rol FROM gestion_roles
      WHERE usuario_id = $1 FOR SHARE
    `, [req.user.id])).rows[0];

    if (permission?.rol !== 'gestor') {
      return await abort(403, 'Tu permiso de gestión cambió.');
    }

    // Same operator-first order as the operator acceptance route.
    let operator;

    if (assignment) {
      operator = (await client.query(`
        SELECT * FROM operadores_pipa WHERE id = $1 FOR UPDATE
      `, [body.operador_id])).rows[0];

      if (!operator?.disponible) {
        return await abort(409, 'La pipa ya no está disponible. Actualiza el detalle.');
      }
    }

    const order = (await client.query(`
      SELECT * FROM pedidos_pipa WHERE id = $1 FOR UPDATE
    `, [req.params.id])).rows[0];

    if (!order) return await abort(404, 'Pedido no encontrado.');

    if (order.gestion_version !== body.version) {
      return await abort(409, 'El pedido cambió. Copia tu nota y recarga el detalle antes de guardar.');
    }

    let updated;

    if (assignment) {
      if (order.estado !== 'solicitada' || order.operador_id !== null) {
        return await abort(409, 'Solo puedes asignar pedidos solicitados sin pipa.');
      }

      if (operator.usuario_id === order.usuario_id || operator.capacidad < order.litros) {
        return await abort(400, 'La pipa debe cubrir los litros y pertenecer a otra cuenta que la solicitante.');
      }

      const busy = await client.query(`
        SELECT id FROM pedidos_pipa
        WHERE operador_id = $1 AND estado NOT IN ('completada', 'cancelada')
      `, [operator.id]);

      if (busy.rows.length) {
        return await abort(409, 'La pipa tiene otra entrega activa.');
      }

      updated = (await client.query(`
        UPDATE pedidos_pipa
        SET operador_id = $2, estado = 'asignada', actualizado = NOW()
        WHERE id = $1
        RETURNING id, estado, operador_id, gestion_version
      `, [order.id, operator.id])).rows[0];

      await client.query(`
        INSERT INTO notificaciones (
          usuario_id, pedido_id, evento, destinatario, titulo,
          mensaje, tipo, push_estado, push_intentos, push_proximo
        ) VALUES (
          $1, $2, 'asignacion_gestor', 'operador',
          'Pedido asignado por el centro de control',
          'Tienes un pedido asignado. Consulta la entrega y prepara su cotización.',
          'pipa', 'pendiente', 0, NOW()
        ) ON CONFLICT DO NOTHING
      `, [operator.usuario_id, order.id]);
    } else {
      updated = (await client.query(`
        UPDATE pedidos_pipa SET gestion_version = gestion_version + 1
        WHERE id = $1
        RETURNING id, estado, operador_id, gestion_version
      `, [order.id])).rows[0];
    }

    await client.query(`
      INSERT INTO pipa_gestion_historial (
        pedido_id, actor_id, accion, operador_id, estado, nota, version
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      order.id,
      req.user.id,
      body.accion,
      updated.operador_id,
      updated.estado,
      body.nota.trim(),
      updated.gestion_version,
    ]);

    await client.query('COMMIT');
    res.json(updated);
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    fail(res, error);
  } finally {
    client?.release();
  }
});

module.exports = router;
