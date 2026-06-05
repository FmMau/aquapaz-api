const jwt = require('jsonwebtoken');
const pool = require('../database/db');

module.exports = async function (req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Sin token' });

    const token = authHeader.replace('Bearer ', '');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const result = await pool.query(
      'SELECT id, nombre, email, colonia FROM usuarios WHERE id = $1',
      [decoded.id]
    );

    if (result.rows.length === 0) return res.status(401).json({ error: 'Usuario no encontrado' });

    req.user = result.rows[0];
    next();
  } catch (error) {
    console.log('auth.middleware error:', error);
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
};
