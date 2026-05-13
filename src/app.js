const express = require('express');
const cors = require('cors');

const reportesRoutes = require('./routes/reportes.routes');

const app = express();

app.use(cors());
app.use(express.json());

app.use('/reportes', reportesRoutes);

app.listen(3000, '0.0.0.0', () => {
  console.log('Servidor corriendo en puerto 3000');
});