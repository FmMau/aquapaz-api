const express = require('express');
const crypto = require('node:crypto');

const CALIBRATION = [[220, 0], [166, 1], [115, 2], [57, 3]];
const STALE_MS = 30000;
const hash = key => crypto.createHash('sha256').update(key).digest('hex');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function volume(mm) {
  if (mm >= 220) return 0;
  if (mm <= 57) return 3;
  for (let i = 0; i < CALIBRATION.length - 1; i++) {
    const [far, liters] = CALIBRATION[i], [near] = CALIBRATION[i + 1];
    if (mm >= near) return liters + (far - mm) / (far - near);
  }
}

function present(row, now = Date.now()) {
  const age = row.received_at ? now - new Date(row.received_at).getTime() : Infinity;
  const connected = age >= 0 && age <= STALE_MS;
  const calibrated = row.sensor_status === 'ok' && row.distance_mm >= 57 && row.distance_mm <= 220;
  const liters = connected && calibrated ? volume(row.distance_mm) : null;
  return {
    id: row.public_id, nombre: row.nombre, received_at: row.received_at,
    sensor_status: row.sensor_status, distance_mm: row.distance_mm,
    status: !row.received_at ? 'waiting' : !connected ? 'offline' :
      row.sensor_status !== 'ok' ? row.sensor_status : !calibrated ? 'uncalibrated' : 'online',
    liters, percent: liters === null ? null : liters / 3 * 100,
    demo_max_liters: 3, stale_after_ms: STALE_MS,
  };
}

function createRouter({ pool, auth }) {
  const router = express.Router();
  const wrap = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (error) {
      console.error('AquaHome:', error.code || error.name);
      res.status(503).json({ error: 'AquaHome no disponible. Intenta nuevamente.' });
    }
  };

  // Device credentials never pass through user JWT authentication.
  router.post('/mediciones', wrap(async (req, res) => {
    const key = req.get('X-Device-Key');
    if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) return res.status(401).json({ error: 'Credencial de dispositivo inválida' });
    const device = (await pool.query('SELECT id, received_at FROM aquahome_devices WHERE key_hash = $1 AND revoked = false', [hash(key)])).rows[0];
    if (!device) return res.status(401).json({ error: 'Credencial de dispositivo inválida' });
    const { status, distance_mm: mm } = req.body || {};
    if (!['ok', 'no_data', 'out_of_range'].includes(status) ||
        (status === 'ok' ? !Number.isInteger(mm) || mm < 30 || mm > 4500 : mm !== null)) {
      return res.status(400).json({ error: 'Envía status y distance_mm entero (30–4500), o null si el sensor no tiene una lectura válida' });
    }
    const result = await pool.query(`UPDATE aquahome_devices SET received_at = CURRENT_TIMESTAMP,
      sensor_status = $2, distance_mm = $3 WHERE id = $1 AND key_hash = $4 AND revoked = false
      AND (received_at IS NULL OR received_at < CURRENT_TIMESTAMP - INTERVAL '1 second') RETURNING received_at`,
    [device.id, status, mm, hash(key)]);
    if (!result.rows.length) return res.status(429).json({ error: 'Espera antes de enviar otra medición' });
    res.json({ success: true, received_at: result.rows[0].received_at });
  }));

  router.use(auth);
  router.get('/dispositivos', wrap(async (req, res) => {
    const result = await pool.query('SELECT public_id, nombre, received_at, sensor_status, distance_mm FROM aquahome_devices WHERE usuario_id = $1 AND revoked = false ORDER BY id', [req.user.id]);
    res.json({ devices: result.rows.map(row => present(row)), server_time: new Date().toISOString() });
  }));
  router.post('/dispositivos', wrap(async (req, res) => {
    const nombre = req.body?.nombre;
    if (typeof nombre !== 'string' || !nombre.trim() || nombre.trim().length > 80) return res.status(400).json({ error: 'Escribe un nombre de 1 a 80 caracteres' });
    const key = crypto.randomBytes(32).toString('hex'), id = crypto.randomUUID();
    // Credentials are random; only their SHA-256 digest is persisted.
    const result = await pool.query(`WITH owner AS (SELECT id FROM usuarios WHERE id = $1 FOR UPDATE)
      INSERT INTO aquahome_devices(public_id, usuario_id, nombre, key_hash)
      SELECT $2, owner.id, $3, $4 FROM owner
      WHERE (SELECT COUNT(*) FROM aquahome_devices WHERE usuario_id = $1 AND revoked = false) < 10
      RETURNING public_id, nombre`, [req.user.id, id, nombre.trim(), hash(key)]);
    if (!result.rows.length) return res.status(409).json({ error: 'Máximo de 10 dispositivos. Revoca uno para continuar.' });
    res.status(201).json({ device: { id, nombre: nombre.trim() }, device_key: key });
  }));
  router.post('/dispositivos/:id/credencial', wrap(async (req, res) => {
    if (!uuid(req.params.id)) return res.status(400).json({ error: 'Identificador inválido' });
    const key = crypto.randomBytes(32).toString('hex');
    const result = await pool.query(`UPDATE aquahome_devices SET key_hash = $3, received_at = NULL,
      sensor_status = NULL, distance_mm = NULL WHERE public_id = $1 AND usuario_id = $2 AND revoked = false RETURNING public_id`,
    [req.params.id, req.user.id, hash(key)]);
    if (!result.rows.length) return res.status(404).json({ error: 'Dispositivo no encontrado' });
    res.json({ device_key: key });
  }));
  router.delete('/dispositivos/:id', wrap(async (req, res) => {
    if (!uuid(req.params.id)) return res.status(400).json({ error: 'Identificador inválido' });
    const result = await pool.query('UPDATE aquahome_devices SET revoked = true WHERE public_id = $1 AND usuario_id = $2 AND revoked = false RETURNING public_id', [req.params.id, req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Dispositivo no encontrado' });
    res.json({ success: true });
  }));
  return router;
}

module.exports = { createRouter, volume, present };
