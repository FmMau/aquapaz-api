require('dotenv').config();

const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {

  return res.status(200).json({

    success: true,

    message:
      'AquaPaz API funcionando'

  });

});

const PORT = process.env.PORT || 8080;

const server = app.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log(
      `Servidor corriendo en puerto ${PORT}`
    );

  }
);

// MANTENER PROCESO VIVO
setInterval(() => {

  console.log('Servidor activo');

}, 30000);

process.on('uncaughtException', (err) => {

  console.error(
    'UNCAUGHT EXCEPTION:',
    err
  );

});

process.on('unhandledRejection', (err) => {

  console.error(
    'UNHANDLED REJECTION:',
    err
  );

});