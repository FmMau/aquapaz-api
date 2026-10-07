const router = require('express').Router();
const pool = require('../database/db');
const { createMailer } = require('../services/auth-mail');
const { createPasswordAuth } = require('../services/password-auth');
const { createSocialProvider } = require('../services/social-provider');
const { createSocialAuth } = require('../services/social-auth');
const { limit } = require('../services/auth-security');
const mailer = createMailer(), provider = createSocialProvider();
const password = createPasswordAuth({ pool, mailer }), social = createSocialAuth({ pool, provider });
const handle = (operation, minimumMs = 0) => async (req,res) => {
  const started = Date.now();
  res.set('Cache-Control','no-store');
  let body, status = 200;
  try { body = await operation(req.body); }
  catch (error) { status = error.status || 503; body = { error:error.status ? error.message : 'No pudimos completar la solicitud. Vuelve a intentar.' }; }
  if (minimumMs) await new Promise(resolve => setTimeout(resolve, Math.max(0, minimumMs - (Date.now() - started))));
  res.status(status).json(body);
};
const guard = (purpose, maximum, minutes) => async (req,res,next) => {
  try { await limit(pool,purpose,req.ip,maximum,minutes); next(); }
  catch (error) { res.status(error.status || 503).json({ error: error.status ? error.message : 'El acceso no está disponible temporalmente.' }); }
};
router.get('/options',(req,res) => { res.set('Cache-Control','no-store').json({ google: provider.ready('google'), apple: provider.ready('apple'), recovery: mailer.ready() }); });
router.post('/register',guard('register',10,15),handle(password.register));
router.post('/login',guard('login',20,15),handle(password.login));
router.post('/password/forgot',guard('forgot',5,15),handle(password.forgot,500));
router.post('/password/reset',guard('reset',10,15),handle(password.reset));
router.post('/social/start',guard('social-start',15,15),handle(social.start));
router.post('/social/inspect',guard('social-inspect',30,15),handle(social.inspect));
router.post('/social/finish',guard('social-finish',10,15),handle(social.finish));
const callback = async (req,res) => {
  res.set({ 'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer', 'X-Content-Type-Options':'nosniff' });
  try { res.redirect(303,await social.callback(req.params.provider,req.method === 'POST' ? req.body : req.query)); }
  catch { res.status(400).type('text/plain').send('No pudimos completar el acceso. Regresa a AquaPaz y vuelve a intentar.'); }
};
router.get('/social/callback/:provider',guard('social-callback',30,15),callback);
router.post('/social/callback/:provider',require('express').urlencoded({ extended:false,limit:'16kb' }),guard('social-callback',30,15),callback);
module.exports = router;
