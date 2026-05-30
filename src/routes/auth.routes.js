const express = require('express');

const router = express.Router();

const bcrypt = require('bcryptjs');

const jwt = require('jsonwebtoken');

const pool =
  require('../database/db');


// REGISTER

router.post('/register', async (
  req,
  res
) => {

  try {

    const {
      nombre,
      email,
      telefono,
      password,
      colonia
    } = req.body;

    // hash password
    const hashedPassword =
      await bcrypt.hash(password, 10);

    const result =
      await pool.query(

        `
        INSERT INTO usuarios
        (
          nombre,
          email,
          telefono,
          password,
          colonia
        )

        VALUES ($1,$2,$3,$4,$5)

        RETURNING id, nombre, email
        `,

        [
          nombre,
          email,
          telefono,
          hashedPassword,
          colonia
        ]
      );

    // token
    const token = jwt.sign(

      {
        id: result.rows[0].id,
        email,
      },

      process.env.JWT_SECRET,

      {
        expiresIn: '7d'
      }

    );

    res.json({

      user: result.rows[0],
      token,

    });

  } catch (error) {

    console.log(error);

    res.status(500).json({
      error: 'Error registrando usuario'
    });

  }

});


// LOGIN

router.post('/login', async (
  req,
  res
) => {

  try {

    const {
      email,
      password
    } = req.body;

    const result =
      await pool.query(

        `
        SELECT *
        FROM usuarios
        WHERE email = $1
        `,

        [email]
      );

    if (
      result.rows.length === 0
    ) {

      return res.status(400).json({

        error:
          'Usuario no encontrado'

      });

    }

    const user = result.rows[0];

    // compare password
    const validPassword =
      await bcrypt.compare(

        password,
        user.password

      );

    if (!validPassword) {

      return res.status(400).json({

        error:
          'Contraseña incorrecta'

      });

    }

    // token
    const token = jwt.sign(

      {
        id: user.id,
        email: user.email,
      },

      process.env.JWT_SECRET,

      {
        expiresIn: '7d'
      }

    );

    res.json({

      user: {

        id: user.id,
        nombre: user.nombre,
        email: user.email,
      },

      token,

    });

  } catch (error) {

    console.log(
      'REGISTER ERROR:',
      error
    );


    res.status(500).json({
      error: 'Error registrando usuario'
    });

  }

});

module.exports = router;