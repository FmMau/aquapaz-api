const express = require('express');
const pool = require('../database/db');
const router = express.Router();
router.use(require('../middlewares/auth.middleware'));
const states = ['nuevo', 'en_revision', 'en_atencion', 'resuelto', 'descartado'];
const transitions = {
  nuevo: ['en_revision', 'descartado'],
  en_revision: ['en_atencion', 'descartado'],
  en_atencion: ['en_revision', 'resuelto'],
  resuelto: ['en_revision'], descartado: ['en_revision'],
};
const validId = value => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));
const fields = `r.id, r.colonia, r.tipo, r.estado, r.comentario, r.fecha,
  r.estado_atencion, r.responsable_id, u.nombre AS responsable_nombre,
  r.version_atencion, r.atencion_actualizada_en`;
const join = 'FROM reportes r LEFT JOIN usuarios u ON u.id = r.responsable_id';
function fail(res, error) {
  console.error('Report management failed:', error.code || error.name);
  res.status(503).json({ error: 'Gestión de reportes no disponible. Intenta de nuevo.' });
}

// Recheck the database on every request: token payloads cannot grant staff access.
router.use(async (req, res, next) => {
  try {
    const role = (await pool.query('SELECT rol FROM gestion_roles WHERE usuario_id = $1', [req.user.id])).rows[0]?.rol;
    if (!['gestor', 'consulta'].includes(role)) return res.status(403).json({ error: 'Tu cuenta no tiene acceso a la bandeja de gestión.' });
    req.gestionRole = role;
    res.set('Cache-Control', 'no-store');
    next();
  } catch (error) { fail(res, error); }
});

router.get('/contexto', async (req, res) => {
  try {
    const responsables = await pool.query(`SELECT u.id, u.nombre FROM usuarios u
      JOIN gestion_roles g ON g.usuario_id = u.id WHERE g.rol = 'gestor' ORDER BY u.nombre, u.id`);
    const colonias = await pool.query('SELECT DISTINCT colonia FROM reportes WHERE colonia IS NOT NULL ORDER BY colonia');
    res.json({ permisos: { consultar: true, gestionar: req.gestionRole === 'gestor' }, responsables: responsables.rows, colonias: colonias.rows.map(r => r.colonia) });
  } catch (error) { fail(res, error); }
});

router.get('/resumen', async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const counts = await client.query(`SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE estado_atencion IN ('nuevo','en_revision','en_atencion'))::int AS pendientes,
      COUNT(*) FILTER (WHERE estado_atencion IN ('nuevo','en_revision','en_atencion') AND responsable_id IS NULL)::int AS sin_responsable,
      COUNT(*) FILTER (WHERE estado_atencion = 'nuevo')::int AS nuevos,
      COUNT(*) FILTER (WHERE estado_atencion = 'en_revision')::int AS en_revision,
      COUNT(*) FILTER (WHERE estado_atencion = 'en_atencion')::int AS en_atencion,
      COUNT(*) FILTER (WHERE estado_atencion = 'resuelto')::int AS resueltos,
      COUNT(*) FILTER (WHERE estado_atencion = 'descartado')::int AS descartados FROM reportes`);
    const pending = await client.query(`SELECT ${fields} ${join}
      WHERE r.estado_atencion IN ('nuevo','en_revision','en_atencion')
      ORDER BY (r.responsable_id IS NULL) DESC, r.fecha ASC, r.id ASC LIMIT 5`);
    const active = await client.query(`SELECT ${fields} ${join}
      WHERE r.estado_atencion = 'en_atencion' ORDER BY r.fecha ASC, r.id ASC LIMIT 5`);
    await client.query('COMMIT');
    res.json({ resumen: counts.rows[0], pendientes: pending.rows, en_atencion: active.rows, actualizado: new Date().toISOString() });
  } catch (error) { if (client) await client.query('ROLLBACK').catch(() => {}); fail(res, error); }
  finally { client?.release(); }
});

router.get('/', async (req, res) => {
  const query = req.query;
  const values = [], conditions = [];
  const add = (sql, value) => { values.push(value); conditions.push(sql.replace('?', `$${values.length}`)); };
  const invalid = () => res.status(400).json({ error: 'Filtros inválidos.' });
  const allowed = ['q', 'colonia', 'tipo', 'estado_atencion', 'responsable_id', 'desde', 'hasta', 'pagina', 'limite', 'pendientes'];
  if (Object.keys(query).some(key => !allowed.includes(key)) || Object.values(query).some(value => typeof value !== 'string')) return invalid();
  if (query.q) {
    if (query.q.length > 100) return invalid();
    // A literal substring search avoids treating citizen input as LIKE patterns.
    add("position(lower(?) in lower(concat_ws(' ', r.id::text, r.colonia, r.comentario))) > 0", query.q.trim());
  }
  if (query.colonia) { if (query.colonia.length > 100) return invalid(); add('r.colonia = ?', query.colonia); }
  if (query.tipo) { if (!['agua', 'fuga'].includes(query.tipo)) return invalid(); add('r.tipo = ?', query.tipo); }
  if (query.estado_atencion) { if (!states.includes(query.estado_atencion)) return invalid(); add('r.estado_atencion = ?', query.estado_atencion); }
  if (query.pendientes !== undefined) {
    if (query.pendientes !== 'true') return invalid();
    conditions.push("r.estado_atencion IN ('nuevo','en_revision','en_atencion')");
  }
  if (query.responsable_id === 'sin_asignar') conditions.push('r.responsable_id IS NULL');
  else if (query.responsable_id) { if (!validId(query.responsable_id)) return invalid(); add('r.responsable_id = ?', Number(query.responsable_id)); }
  for (const name of ['desde', 'hasta']) {
    if (query[name]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(query[name]) || !Number.isFinite(Date.parse(query[name])) || new Date(query[name]).toISOString().slice(0,10) !== query[name]) return invalid();
      add(name === 'desde' ? 'r.fecha >= ?::date' : "r.fecha < ?::date + INTERVAL '1 day'", query[name]);
    }
  }
  if (query.desde && query.hasta && query.desde > query.hasta) return invalid();
  if ((query.pagina && !validId(query.pagina)) || (query.limite && !validId(query.limite))) return invalid();
  const page = Number(query.pagina || 1), limit = Number(query.limite || 20);
  if (page > 100000 || limit > 100) return invalid();
  const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
  try {
    const counts = await pool.query(`SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE r.estado_atencion = 'nuevo')::int AS nuevos,
      COUNT(*) FILTER (WHERE r.estado_atencion IN ('en_revision','en_atencion'))::int AS en_proceso,
      COUNT(*) FILTER (WHERE r.estado_atencion = 'resuelto')::int AS resueltos,
      COUNT(*) FILTER (WHERE r.estado_atencion = 'descartado')::int AS descartados ${join}${where}`, values);
    const reports = await pool.query(`SELECT ${fields} ${join}${where} ORDER BY r.fecha DESC, r.id DESC LIMIT $${values.length+1} OFFSET $${values.length+2}`, [...values, limit, (page-1)*limit]);
    res.json({ reportes: reports.rows, resumen: counts.rows[0], pagina: page, limite: limit });
  } catch (error) { fail(res, error); }
});

router.get('/:id', async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'Folio inválido.' });
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const report = (await client.query(`SELECT ${fields} ${join} WHERE r.id = $1`, [req.params.id])).rows[0];
    if (!report) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Reporte no encontrado.' }); }
    const history = await client.query(`SELECT a.id, a.actor_id, actor.nombre AS actor_nombre,
      a.estado_anterior, a.estado_nuevo, a.responsable_anterior_id, a.responsable_nuevo_id,
      anterior.nombre AS responsable_anterior_nombre, nuevo.nombre AS responsable_nuevo_nombre,
      a.nota, a.version, a.fecha FROM reporte_atenciones a
      JOIN usuarios actor ON actor.id = a.actor_id
      LEFT JOIN usuarios anterior ON anterior.id = a.responsable_anterior_id
      LEFT JOIN usuarios nuevo ON nuevo.id = a.responsable_nuevo_id
      WHERE a.reporte_id = $1 ORDER BY a.version DESC`, [req.params.id]);
    await client.query('COMMIT');
    res.json({ reporte: report, historial: history.rows });
  } catch (error) { if (client) await client.query('ROLLBACK').catch(() => {}); fail(res, error); }
  finally { client?.release(); }
});

router.put('/:id/atencion', async (req, res) => {
  if (req.gestionRole !== 'gestor') return res.status(403).json({ error: 'Tu cuenta tiene acceso de consulta.' });
  const body = req.body || {};
  const { version, estado_atencion: state, responsable_id: responsible, nota } = body;
  if (!validId(req.params.id) || !Number.isSafeInteger(version) || version < 0 || !states.includes(state)
    || !(responsible === null || (Number.isSafeInteger(responsible) && responsible > 0))
    || typeof nota !== 'string' || !nota.trim() || nota.length > 2000
    || Object.keys(body).some(k => !['version','estado_atencion','responsable_id','nota'].includes(k))) {
    return res.status(400).json({ error: 'Indica estado, responsable, versión y una nota de 1 a 2000 caracteres.' });
  }
  let client;
  try {
    client = await pool.connect(); await client.query('BEGIN');
    const abort = async (status, error) => { await client.query('ROLLBACK'); return res.status(status).json({ error }); };
    // Lock staff grants along with the report so revocation cannot race a mutation.
    const ids = [...new Set([req.user.id, responsible].filter(id => id !== null))].sort((a,b)=>a-b);
    const roles = (await client.query('SELECT usuario_id, rol FROM gestion_roles WHERE usuario_id = ANY($1::int[]) ORDER BY usuario_id FOR SHARE', [ids])).rows;
    if (!roles.some(r => r.usuario_id === req.user.id && r.rol === 'gestor')) return await abort(403, 'Tu permiso de gestión cambió.');
    if (responsible !== null && !roles.some(r => r.usuario_id === responsible && r.rol === 'gestor')) return await abort(400, 'El responsable debe tener permiso de gestor vigente.');
    const report = (await client.query('SELECT * FROM reportes WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!report) return await abort(404, 'Reporte no encontrado.');
    if (report.version_atencion !== version) return await abort(409, 'Otro gestor actualizó este reporte. Recarga el detalle antes de guardar.');
    if (report.estado_atencion !== state && !transitions[report.estado_atencion]?.includes(state)) return await abort(400, 'Transición de atención no permitida.');
    if (['en_atencion','resuelto'].includes(state) && responsible === null) return await abort(400, 'Asigna un responsable antes de atender o resolver.');
    const updated = (await client.query(`UPDATE reportes SET estado_atencion = $2, responsable_id = $3,
      version_atencion = version_atencion + 1, atencion_actualizada_en = CURRENT_TIMESTAMP
      WHERE id = $1 RETURNING id, estado_atencion, responsable_id, version_atencion, atencion_actualizada_en`, [req.params.id, state, responsible])).rows[0];
    await client.query(`INSERT INTO reporte_atenciones
      (reporte_id, actor_id, estado_anterior, estado_nuevo, responsable_anterior_id, responsable_nuevo_id, nota, version)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [report.id, req.user.id, report.estado_atencion, state, report.responsable_id, responsible, nota.trim(), updated.version_atencion]);
    await client.query('COMMIT');
    res.json(updated);
  } catch (error) { if (client) await client.query('ROLLBACK').catch(() => {}); fail(res, error); }
  finally { client?.release(); }
});
module.exports = router;
