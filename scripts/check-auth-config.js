// Reports configuration names only; never prints credentials or private keys.
require('dotenv').config({ quiet: true });
const { createPrivateKey } = require('node:crypto');
const { createSocialProvider } = require('../src/services/social-provider');

const groups = {
  google: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  apple: ['APPLE_CLIENT_ID', 'APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_PRIVATE_KEY'],
};
let failed = false;
function problem(message) { console.log(message); failed = true; }
const provider = createSocialProvider();
for (const [name, keys] of Object.entries(groups)) {
  const missing = ['AUTH_PUBLIC_URL', ...keys].filter(key => !process.env[key]?.trim());
  if (missing.length) problem(`${name}: faltan ${missing.join(', ')}`);
  else if (!provider.ready(name)) problem(`${name}: AUTH_PUBLIC_URL debe ser un origen HTTPS sin rutas, query ni credenciales.`);
  else console.log(`${name}: variables presentes (pendiente validar consentimiento real).`);
}
if (process.env.GOOGLE_CLIENT_ID && !process.env.GOOGLE_CLIENT_ID.trim().endsWith('.apps.googleusercontent.com')) {
  problem('google: revisa GOOGLE_CLIENT_ID; debe ser el ID del cliente OAuth web.');
}
if (process.env.APPLE_PRIVATE_KEY) {
  try {
    const key = createPrivateKey(process.env.APPLE_PRIVATE_KEY.replace(/\\n/g, '\n'));
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('Invalid key type');
  } catch { problem('apple: APPLE_PRIVATE_KEY debe contener una clave privada EC P-256 válida (.p8).'); }
}
if (!failed) {
  const base = process.env.AUTH_PUBLIC_URL.replace(/\/$/, '');
  for (const name of Object.keys(groups)) console.log(`Callback ${name}: ${base}/api/auth/social/callback/${name}`);
  console.log('Comprueba /api/auth/options en el servidor desplegado y prueba cada proveedor en la app instalada.');
}
process.exitCode = failed ? 1 : 0;
