require('dotenv').config();

const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

// Routes
const authRoutes = require('./routes/auth.routes');
const notificacionesRoutes = require('./routes/notificaciones.routes');
const reportesRoutes = require('./routes/reportes.routes');

app.use('/api/auth', authRoutes);
app.use('/api/notificaciones', notificacionesRoutes);
app.use('/api/reportes', reportesRoutes);

app.get('/', (req, res) => {
  return res.status(200).json({
    success: true,
    message: 'AquaPaz API funcionando'
  });
});

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
});

process.on('SIGTERM', () => {
  server.close(() => {
    console.log('Servidor cerrado correctamente');
    process.exit(0);
  });
});