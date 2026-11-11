require('dotenv').config();

const express = require('express');
const cors = require('cors');

const app = express();

const webOrigins = (process.env.WEB_PUSH_ORIGINS || 'https://fmmau.github.io').split(',').map(value => value.trim());
app.use(cors({ origin(origin, callback) {
  callback(null, !origin || webOrigins.includes(origin));
}, methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));

// Routes
app.use('/api/aquahome', require('./routes/aquahome.routes').createRouter({ pool: require('./database/db'), auth: require('./middlewares/auth.middleware') }));
const authRoutes = require('./routes/auth.routes');
const notificacionesRoutes = require('./routes/notificaciones.routes');
const reportesRoutes = require('./routes/reportes.routes');

app.use('/api/auth', require('./routes/auth-access.routes'));
app.use('/api/auth', authRoutes);
app.use('/api/auth/perfil', require('./routes/profile.routes'));
app.use('/api/notificaciones', notificacionesRoutes);
app.use('/api/push', require('./routes/push.routes').createRouter({ pool: require('./database/db'), auth: require('./middlewares/auth.middleware') }));
app.use('/api/reportes', reportesRoutes);
app.use('/api/gestion/reportes', require('./routes/gestion-reportes.routes'));
app.use('/api/gestion/pipas', require('./routes/gestion-pipas.routes'));
const pipaMarket = require('./services/pipa-marketplace').createMarketplace({ pool:require('./database/db') });
app.use('/api/pipas', require('./routes/pipa-market.routes').createRouter({ pool:require('./database/db'),auth:require('./middlewares/auth.middleware'),market:pipaMarket }));
app.use('/api/pipas', require('./routes/pipas.routes'));

app.get('/', (req, res) => {
  return res.status(200).json({
    success: true,
    version: require('../package.json').version,
    message: 'AquaPaz API funcionando'
  });
});

const PORT = process.env.PORT || 3000;
const pushWorker = require('./services/pipa-notifications').createPushWorker({ pool: require('./database/db') });
const webPushWorker = require('./services/web-push').createWebPushWorker({ pool: require('./database/db') });
const webPushTimer = setInterval(() => { void webPushWorker.tick(); }, 15000);
webPushTimer.unref();
const pushTimer = setInterval(() => { void pushWorker.tick(); }, 15000);
pushTimer.unref();
const dispatchTimer = setInterval(()=>{ void pipaMarket.tick().catch(error=>console.error('Pipa dispatch failed:',error.code||error.name)); },5000);
dispatchTimer.unref();

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
  clearInterval(pushTimer);
  clearInterval(webPushTimer);
  clearInterval(dispatchTimer);
  server.close(() => {
    console.log('Servidor cerrado correctamente');
    process.exit(0);
  });
});
