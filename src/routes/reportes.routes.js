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


// GET reportes por colonia (para ConfirmScreen)
router.get('/colonia/:colonia', async (req, res) => {
  try {
    const { colonia } = req.params;
    const result = await pool.query(
      `SELECT * FROM reportes
       WHERE colonia = $1 AND tipo = 'agua' AND estado = 'no_agua'
       ORDER BY fecha DESC LIMIT 20`,
      [colonia]
    );
    res.json(result.rows);
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: 'Error obteniendo reportes' });
  }
});

// POST confirmar reporte con consenso en servidor
router.post('/:id/confirmar', async (req, res) => {
  try {
    const { id } = req.params;
    const { decision, usuario_id } = req.body;

    // Guardar confirmación
    await pool.query(
      `INSERT INTO confirmaciones (reporte_id, decision, usuario_id)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [id, decision, usuario_id ?? null]
    );

    // Contar confirmaciones positivas en servidor
    const result = await pool.query(
      `SELECT COUNT(*) as total FROM confirmaciones
       WHERE reporte_id = $1 AND decision = 'confirmar'`,
      [id]
    );

    const total = parseInt(result.rows[0].total);
    const consenso = total >= 3;

    if (consenso) {
      // Notificar a toda la colonia
      const reporte = await pool.query(
        'SELECT * FROM reportes WHERE id = $1', [id]
      );
      if (reporte.rows[0]) {
        await enviarPushAColonia(
          reporte.rows[0].colonia,
          -1, // notificar a todos
          'Reporte validado por la comunidad',
          `${total} vecinos confirmaron falta de agua en ${reporte.rows[0].colonia}`
        );
      }
    }

    res.json({ success: true, confirmaciones: total, consenso });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: 'Error confirmando reporte' });
  }
});

module.exports = router;