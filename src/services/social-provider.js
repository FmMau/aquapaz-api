const jwt = require('jsonwebtoken');
const { authError } = require('./auth-validation');
async function verifyIdentity({ token, settings, nonce, jwks }) {
  const { jwtVerify } = await import('jose');
  const { payload } = await jwtVerify(token, jwks, { issuer: settings.issuer, audience: settings.clientId, algorithms: ['RS256'], requiredClaims: ['sub','exp','iat','nonce'], maxTokenAge:'10m', clockTolerance:5 });
  if (payload.nonce !== nonce || (payload.azp && payload.azp !== settings.clientId) || ![true,'true'].includes(payload.email_verified) || typeof payload.email !== 'string' || typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255) throw authError(401,'El proveedor no confirmó esta identidad.');
  return { subject:payload.sub,email:payload.email,nombre:typeof payload.name==='string'?payload.name.slice(0,100):'' };
}
function createSocialProvider(env = process.env, fetcher = fetch) {
  const keys = new Map();
  const publicBase = () => {
    try { const url = new URL(env.AUTH_PUBLIC_URL); return url.protocol === 'https:' && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash ? url.href.replace(/\/$/,'') : null; }
    catch { return null; }
  };
  const ready = provider => !!publicBase() && (provider === 'google' ? !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) :
    provider === 'apple' && !!(env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY));
  const config = provider => {
    if (!ready(provider)) throw authError(503, 'Este proveedor aún no está configurado.');
    return provider === 'google' ? { clientId: env.GOOGLE_CLIENT_ID, authorization: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', issuer: ['https://accounts.google.com','accounts.google.com'], keys: 'https://www.googleapis.com/oauth2/v3/certs' } :
      { clientId: env.APPLE_CLIENT_ID, authorization: 'https://appleid.apple.com/auth/authorize', token: 'https://appleid.apple.com/auth/token', issuer: 'https://appleid.apple.com', keys: 'https://appleid.apple.com/auth/keys' };
  };
  const callback = provider => `${publicBase()}/api/auth/social/callback/${provider}`;
  return {
    ready,
    authorization(provider, state, nonce, verifierChallenge) {
      const settings = config(provider); const url = new URL(settings.authorization);
      const params = { client_id: settings.clientId, redirect_uri: callback(provider), response_type: 'code', scope: provider === 'google' ? 'openid email profile' : 'name email', state, nonce };
      if (provider === 'google') Object.assign(params, { code_challenge: verifierChallenge, code_challenge_method: 'S256', prompt: 'select_account' });
      else params.response_mode = 'form_post';
      url.search = new URLSearchParams(params).toString(); return url.href;
    },
    async exchange(provider, code, flow) {
      const settings = config(provider);
      const secret = provider === 'google' ? env.GOOGLE_CLIENT_SECRET : jwt.sign({}, env.APPLE_PRIVATE_KEY.replace(/\\n/g,'\n'), {
        algorithm: 'ES256', keyid: env.APPLE_KEY_ID, issuer: env.APPLE_TEAM_ID, subject: settings.clientId, audience: 'https://appleid.apple.com', expiresIn: '5m' });
      const body = { client_id: settings.clientId, client_secret: secret, code, grant_type: 'authorization_code', redirect_uri: callback(provider) };
      if (provider === 'google') body.code_verifier = flow.provider_verifier;
      const response = await fetcher(settings.token, { method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
      if (!response.ok) throw authError(401, 'No se pudo validar el acceso con el proveedor.');
      const tokens = await response.json();
      const { createRemoteJWKSet } = await import('jose');
      if (!keys.has(provider)) keys.set(provider, createRemoteJWKSet(new URL(settings.keys), { timeoutDuration: 5000, cacheMaxAge: 600000 }));
      return verifyIdentity({ token:tokens.id_token,settings,nonce:flow.nonce,jwks:keys.get(provider) });
    },
  };
}
module.exports = { createSocialProvider, verifyIdentity };
