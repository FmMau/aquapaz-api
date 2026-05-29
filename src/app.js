const express = require('express');

const cors = require('cors');

const reportesRoutes =
require('./routes/reportes.routes');

const authRoutes =
require('./routes/auth.routes');

const notificacionesRoutes =
require('./routes/notificaciones.routes');

const app = express();

app.use(cors());

app.use(express.json());

app.use('/reportes', reportesRoutes);

app.use('/api/auth', authRoutes);

app.use('/notificaciones', notificacionesRoutes);

const PORT =
  process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {

  console.log(
    `Servidor corriendo en puerto ${PORT}`
  );

});