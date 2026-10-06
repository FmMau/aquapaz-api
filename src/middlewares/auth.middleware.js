const jwt = require('jsonwebtoken');
const pool = require('../database/db');

module.exports = async function (req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (typeof authHeader !== 'string' || !/^Bearer \S+$/i.test(authHeader)) return res.status(401).json({ error: 'Sin token válido' });

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const result = await pool.query(
      'SELECT id, nombre, email, colonia FROM usuarios WHERE id = $1',
      [decoded.id]
    );

    if (result.rows.length === 0) return res.status(401).json({ error: 'Usuario no encontrado' });

    req.user = result.rows[0];
    next();
  } catch (error) {
    if (['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(error.name)) {
      return res.status(401).json({ error: 'Token inválido o expirado' });
    }
    console.error('Authentication failed:', error.code || error.name);
    return res.status(503).json({ error: 'Autenticación no disponible' });
  }
};
