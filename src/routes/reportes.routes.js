const express = require('express');
const router = express.Router();
const pool = require('../database/db');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

const enviarPushAColonia = async (colonia, usuarioIdExcluir, titulo, mensaje) => {
  try {
    const result = await pool.query(
      `SELECT push_token FROM usuarios
       WHERE colonia = $1 AND id != $2 AND push_token IS NOT NULL`,
      [colonia, usuarioIdExcluir]
    );

    const tokens = result.rows.map((r) => r.push_token);
    if (tokens.length === 0) return;

    await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        tokens.map((token) => ({
          to: token,
          title: titulo,
          body: mensaje,
          sound: 'default',
        }))
      ),
    });
  } catch (error) {
    console.log('Error enviando push:', error);
  }
};

// GET reportes
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM reportes ORDER BY fecha DESC'
    );
    res.json(result.rows);
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: 'Error al obtener reportes' });
  }
});

// POST reporte → guarda y notifica a la colonia
router.post('/', async (req, res) => {
  try {
    const { colonia, tipo, estado, comentario, usuario_id } = req.body;

    const result = await pool.query(
      `INSERT INTO reportes (colonia, tipo, estado, comentario, usuario_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [colonia, tipo, estado, comentario, usuario_id ?? null]
    );

    const reporte = result.rows[0];

    const estadoTexto = {
      no_agua: 'sin agua',
      baja_presion: 'con baja presión',
      tengo_agua: 'con agua normal',
    }[estado] ?? estado;

    await enviarPushAColonia(
      colonia,
      usuario_id ?? -1,
      `Reporte en ${colonia}`,
      `Un vecino reporta ${estadoTexto}. ¿Confirmas?`
    );

    res.json(reporte);
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: 'Error al crear reporte' });
  }
});

module.exports = router;