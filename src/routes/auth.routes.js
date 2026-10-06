const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../database/db');
const TOKEN_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';

const normalizePushToken = (token) => {
  if (typeof token !== 'string') return null;

  const trimmedToken = token.trim();
  if (!/^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/.test(trimmedToken)) return null;

  return trimmedToken;
};

// REGISTER
router.post('/register', async (req, res) => {
  try {
    const { nombre, email, telefono, password, colonia, push_token, pushToken } = req.body;
    if (![nombre, email, telefono, password, colonia].every(v => typeof v === 'string' && v.trim()) || password.length < 8 || Buffer.byteLength(password, 'utf8') > 72 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Datos de registro inválidos; contraseña de 8 a 72 caracteres' });
    }
    const pushTokenToSave = normalizePushToken(push_token ?? pushToken);
    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO usuarios (nombre, email, telefono, password, colonia, push_token)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, nombre, email, colonia`,
      [nombre, email, telefono, hashedPassword, colonia, pushTokenToSave]
    );

    const token = jwt.sign(
      { id: result.rows[0].id, email },
      process.env.JWT_SECRET,
      { expiresIn: TOKEN_EXPIRES_IN }
    );

    res.json({ user: result.rows[0], token });
  } catch (error) {
    console.error('Auth request failed:', error.code || error.name);
    if (error.code === '23505') return res.status(409).json({ error: 'El usuario ya existe' });
    res.status(500).json({ error: 'Error registrando usuario' });
  }
});

// LOGIN
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password || Buffer.byteLength(password, 'utf8') > 72) {
      return res.status(400).json({ error: 'Credenciales inválidas' });
    }

    const result = await pool.query(
      'SELECT * FROM usuarios WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0)
      return res.status(401).json({ error: 'Credenciales inválidas' });

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword)
      return res.status(401).json({ error: 'Credenciales inválidas' });

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
    console.error('Auth request failed:', error.code || error.name);
    res.status(500).json({ error: 'Error en login' });
  }
});

const authMiddleware = require('../middlewares/auth.middleware');

// GUARDAR PUSH TOKEN
router.post('/push-token', authMiddleware, async (req, res) => {
  try {
    const pushToken = req.body.token ?? req.body.push_token ?? req.body.pushToken ?? null;
    const pushTokenToSave = normalizePushToken(pushToken);

    if (!pushTokenToSave) {
      return res.status(400).json({ error: 'Push token invalido' });
    }

    await pool.query(
      'UPDATE usuarios SET push_token = $1 WHERE id = $2',
      [pushTokenToSave, req.user.id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Auth request failed:', error.code || error.name);
    res.status(500).json({ error: 'Error guardando push token' });
  }
});

module.exports = router;
