const jwt = require('jsonwebtoken');
const pool = require('../database/db');

module.exports = async function (req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (typeof authHeader !== 'string' || !/^Bearer \S+$/i.test(authHeader)) return res.status(401).json({ error: 'Sin token válido' });

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });

    const result = await pool.query(
      'SELECT id, nombre, email, colonia, auth_version FROM usuarios WHERE id = $1',
      [decoded.id]
    );

    if (result.rows.length === 0) return res.status(401).json({ error: 'Usuario no encontrado' });
    if ((decoded.v || 0) !== (result.rows[0].auth_version || 0)) return res.status(401).json({ error: 'Sesión revocada. Inicia sesión de nuevo.' });

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
