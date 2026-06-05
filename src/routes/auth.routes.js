const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../database/db');
const TOKEN_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';

const normalizePushToken = (token) => {
  if (typeof token !== 'string') return null;

  const trimmedToken = token.trim();
  if (!trimmedToken) return null;

  return trimmedToken;
};

// REGISTER
router.post('/register', async (req, res) => {
  try {
    console.log('auth.routes /register body:', req.body);
    const { nombre, email, telefono, password, colonia, push_token, pushToken } = req.body;
    const pushTokenToSave = normalizePushToken(push_token ?? pushToken);
    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO usuarios (nombre, email, telefono, password, colonia, push_token)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, nombre, email, colonia, push_token`,
      [nombre, email, telefono, hashedPassword, colonia, pushTokenToSave]
    );

    const token = jwt.sign(
      { id: result.rows[0].id, email },
      process.env.JWT_SECRET,
      { expiresIn: TOKEN_EXPIRES_IN }
    );

    res.json({ user: result.rows[0], token });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: 'Error registrando usuario' });
  }
});

// LOGIN
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await pool.query(
      'SELECT * FROM usuarios WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0)
      return res.status(400).json({ error: 'Usuario no encontrado' });

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword)
      return res.status(400).json({ error: 'Contraseña incorrecta' });

    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: TOKEN_EXPIRES_IN }
    );

    res.json({
      user: { id: user.id, nombre: user.nombre, email: user.email, colonia: user.colonia },
      token,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: 'Error en login' });
  }
});

const authMiddleware = require('../middlewares/auth.middleware');

// GUARDAR PUSH TOKEN
router.post('/push-token', authMiddleware, async (req, res) => {
  try {
    const pushToken = req.body.token ?? req.body.push_token ?? req.body.pushToken ?? null;
    const pushTokenToSave = normalizePushToken(pushToken);
    console.log('auth.routes /push-token user:', req.user.id, 'body:', req.body, 'resolvedToken:', pushTokenToSave);

    if (!pushTokenToSave) {
      return res.status(400).json({ error: 'Push token invalido' });
    }

    await pool.query(
      'UPDATE usuarios SET push_token = $1 WHERE id = $2',
      [pushTokenToSave, req.user.id]
    );

    res.json({ success: true });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: 'Error guardando push token' });
  }
});

module.exports = router;
