const express = require('express');
const router = express.Router();

const pool = require('../database/db');

router.get('/', async (req, res) => {

  try {

    const result = await pool.query(
      'SELECT * FROM reportes ORDER BY fecha DESC'
    );

    res.json(result.rows);

  } catch (error) {

    console.log(error);
    res.status(500).json({
      error: 'Error al obtener reportes',
    });

  }

});

router.post('/', async (req, res) => {

  try {

    const {
      colonia,
      tipo,
      estado,
      comentario,
    } = req.body;

    const result = await pool.query(
      `
      INSERT INTO reportes
      (colonia, tipo, estado, comentario)
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [colonia, tipo, estado, comentario]
    );

    res.json(result.rows[0]);

  } catch (error) {

    console.log(error);

    res.status(500).json({
      error: 'Error al crear reporte',
    });

  }

});

module.exports = router;