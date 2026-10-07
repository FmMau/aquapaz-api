const bcrypt = require('bcryptjs');
const { email, validEmail, profileError, authError } = require('./auth-validation');
const { random, digest, challenge, transaction, issueSession, emailLock } = require('./auth-security');
const proof = body => typeof body?.code === 'string' && /^[A-Za-z0-9_-]{43}$/.test(body.code) && typeof body.code_verifier === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier);
function createSocialAuth({ pool, provider }) {
  async function inspectTicket(client, body, lock = false) {
    if (!proof(body)) throw authError(400,'Acceso social inválido. Vuelve a iniciar sesión.');
    const result = await client.query(`SELECT * FROM auth_tickets WHERE code_hash=$1 AND expires_at>NOW()${lock ? ' FOR UPDATE' : ''}`, [digest(body.code)]);
    const ticket = result.rows[0];
    if (!ticket || challenge(body.code_verifier) !== ticket.challenge) throw authError(401,'El acceso social caducó o no es válido. Vuelve a iniciar sesión.');
    return ticket;
  }
  async function account(client, ticket) {
    const identity = await client.query('SELECT u.* FROM auth_identities i JOIN usuarios u ON u.id=i.usuario_id WHERE i.provider=$1 AND i.subject=$2',[ticket.provider,ticket.subject]);
    if (identity.rows.length) return { action: 'login', user: identity.rows[0] };
    const result = await client.query('SELECT * FROM usuarios WHERE lower(btrim(email))=$1',[ticket.email]);
    if (result.rows.length > 1) throw authError(409,'Hay un conflicto con este correo. Contacta a soporte.');
    return result.rows.length ? { action: 'link', user: result.rows[0] } : { action: 'register' };
  }
  return {
    async start(body) {
      if (!['google','apple'].includes(body?.provider) || !/^[A-Za-z0-9_-]{43}$/.test(body?.code_challenge || '')) throw authError(400,'Solicitud social inválida');
      if (!provider.ready(body.provider)) throw authError(503,'Este proveedor aún no está configurado.');
      const state = random(), nonce = random(), verifier = random();
      await pool.query('DELETE FROM auth_flows WHERE expires_at<=NOW()');
      await pool.query('DELETE FROM auth_tickets WHERE expires_at<=NOW()');
      await pool.query(`INSERT INTO auth_flows(state_hash,provider,nonce,provider_verifier,challenge,expires_at) VALUES($1,$2,$3,$4,$5,NOW()+INTERVAL '10 minutes')`, [digest(state),body.provider,nonce,verifier,body.code_challenge]);
      return { url: provider.authorization(body.provider,state,nonce,challenge(verifier)) };
    },
    async callback(name, body) {
      if (!['google','apple'].includes(name) || !/^[A-Za-z0-9_-]{43}$/.test(body?.state || '')) throw authError(400,'Solicitud social inválida');
      const { rows } = await pool.query('DELETE FROM auth_flows WHERE state_hash=$1 AND provider=$2 AND expires_at>NOW() RETURNING *',[digest(body.state),name]);
      if (!rows.length || body.error || typeof body.code !== 'string' || body.code.length > 4096) throw authError(401,'El acceso fue cancelado, caducó o no es válido.');
      const identity = await provider.exchange(name,body.code,rows[0]);
      const address = email(identity.email);
      if (!validEmail(address)) throw authError(401,'El proveedor no confirmó un correo válido.');
      const code = random();
      await pool.query(`INSERT INTO auth_tickets(code_hash,provider,subject,email,nombre,challenge,expires_at) VALUES($1,$2,$3,$4,$5,$6,NOW()+INTERVAL '5 minutes')`,
        [digest(code),name,identity.subject,address,identity.nombre,rows[0].challenge]);
      return `aquapaz://oauth?code=${encodeURIComponent(code)}`;
    },
    async inspect(body) {
      const ticket = await inspectTicket(pool,body);
      const result = await account(pool,ticket);
      return { action: result.action, email: ticket.email, nombre: ticket.nombre, provider: ticket.provider };
    },
    async finish(body) {
      return transaction(pool,async client => {
        const ticket = await inspectTicket(client,body,true);
        await emailLock(client,ticket.email);
        const result = await account(client,ticket);
        let user = result.user;
        if (result.action === 'register') {
          const invalid = profileError(body?.profile);
          if (invalid) throw authError(400,invalid);
          const { nombre, telefono, colonia } = body.profile;
          const inserted = await client.query(`INSERT INTO usuarios(nombre,email,telefono,colonia,password) VALUES($1,$2,$3,$4,NULL) RETURNING *`,[nombre.trim(),ticket.email,telefono.trim(),colonia.trim()]);
          user = inserted.rows[0];
        } else if (result.action === 'link') {
          if (!user.password || typeof body.password !== 'string' || Buffer.byteLength(body.password,'utf8') > 72 || !await bcrypt.compare(body.password,user.password)) throw authError(401,'Confirma la contraseña de tu cuenta existente para vincularla. Puedes recuperarla por correo.');
        }
        if (result.action !== 'login') await client.query('INSERT INTO auth_identities(provider,subject,usuario_id) VALUES($1,$2,$3)',[ticket.provider,ticket.subject,user.id]);
        await client.query('DELETE FROM auth_tickets WHERE id=$1',[ticket.id]);
        return issueSession(user);
      });
    },
  };
}
module.exports = { createSocialAuth };
