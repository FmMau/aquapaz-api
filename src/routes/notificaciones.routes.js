const express = require('express');

const router = express.Router();

const pool =
  require('../database/db');


// OBTENER NOTIFICACIONES

router.get('/', async (
  req,
  res
) => {

  try {

    const result =
      await pool.query(

        `
        SELECT *
        FROM notificaciones
        ORDER BY fecha DESC
        `

      );

    res.json(result.rows);

  } catch (error) {

    console.log(error);

    res.status(500).json({

      error:
        'Error obteniendo notificaciones'

    });

  }

});


// CREAR NOTIFICACIÓN

router.post('/', async (
  req,
  res
) => {

  try {

    const {
      mensaje,
      tipo
    } = req.body;

    const result =
      await pool.query(

        `
        INSERT INTO notificaciones
        (
          mensaje,
          tipo
        )

        VALUES ($1, $2)

        RETURNING *
        `,

        [
          mensaje,
          tipo
        ]

      );

    res.json(result.rows[0]);

  } catch (error) {

    console.log(error);

    res.status(500).json({

      error:
        'Error creando notificación'

    });

  }

});


// MARCAR LEÍDA

router.put('/:id/leida', async (
  req,
  res
) => {

  try {

    const { id } = req.params;

    await pool.query(

      `
      UPDATE notificaciones
      SET leido = true
      WHERE id = $1
      `,

      [id]

    );

    res.json({

      success: true

    });

  } catch (error) {

    console.log(error);

    res.status(500).json({

      error:
        'Error actualizando notificación'

    });

  }

});


// CONFIRMAR NOTIFICACIÓN

router.put('/:id/confirmar', async (
  req,
  res
) => {

  try {

    const { id } = req.params;

    await pool.query(

      `
      UPDATE notificaciones

      SET
        confirmada = true,
        leido = true

      WHERE id = $1
      `,

      [id]

    );

    res.json({

      success: true

    });

  } catch (error) {

    console.log(error);

    res.status(500).json({

      error:
        'Error confirmando notificación'

    });

  }

});


// ELIMINAR NOTIFICACIÓN

router.delete('/:id', async (
  req,
  res
) => {

  try {

    const { id } = req.params;

    await pool.query(

      `
      DELETE FROM notificaciones
      WHERE id = $1
      `,

      [id]

    );

    res.json({

      success: true

    });

  } catch (error) {

    console.log(error);

    res.status(500).json({

      error:
        'Error eliminando notificación'

    });

  }

});

module.exports = router;