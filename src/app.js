require('dotenv').config();

const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());

app.use(express.json());

app.get('/', (req, res) => {

  res.json({
    message: 'AquaPaz API funcionando'
  });

});


console.log('JWT:', process.env.JWT_SECRET);
console.log('DATABASE:', process.env.DATABASE_URL);


const PORT =
  process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {

  console.log(
    `Servidor corriendo en puerto ${PORT}`
  );

});