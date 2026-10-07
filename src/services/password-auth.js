const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const { email, validEmail, validPassword, profileError, authError } = require('./auth-validation');
const { transaction, issueSession, emailLock, limit } = require('./auth-security');
// Compare unknown accounts too; never reveal whether a login email is registered.
const dummyHash = bcrypt.hashSync('unused-authentication-dummy-password', 10);
const genericRecovery = { message: 'Si existe una cuenta con ese correo, recibirás un código para recuperar tu contraseña.' };
function createPasswordAuth({ pool, mailer, env = process.env }) {
  const hashCode = (address, code) => crypto.createHmac('sha256', env.JWT_SECRET).update(`password-reset:${address}:${code}`).digest('hex');
  return {
    async register(body) {
      const error = profileError(body);
      if (error) throw authError(400, error);
      const address = email(body.email);
      if (!validEmail(address)) throw authError(400, 'Escribe un correo válido de hasta 120 caracteres');
      if (!validPassword(body.password)) throw authError(400, 'La contraseña necesita al menos 8 caracteres y un máximo de 72 bytes');
      if (Object.keys(body).some(key => !['nombre','email','telefono','password','colonia'].includes(key))) throw authError(400, 'Campos de registro inválidos');
      const hash = await bcrypt.hash(body.password, 10);
      return transaction(pool, async client => {
        await emailLock(client, address);
        const existing = await client.query('SELECT id FROM usuarios WHERE lower(btrim(email))=$1', [address]);
        if (existing.rows.length) throw authError(409, 'Ya existe una cuenta con ese correo. Inicia sesión o recupera tu contraseña.');
        const result = await client.query(`INSERT INTO usuarios(nombre,email,telefono,password,colonia) VALUES($1,$2,$3,$4,$5)
          RETURNING id,nombre,email,telefono,colonia,auth_version`, [body.nombre.trim(), address, body.telefono.trim(), hash, body.colonia.trim()]);
        return issueSession(result.rows[0]);
      });
    },
    async login(body) {
      const address = email(body?.email);
      if (!validEmail(address) || typeof body?.password !== 'string' || !body.password || Buffer.byteLength(body.password,'utf8') > 72) throw authError(400, 'Revisa el correo y la contraseña');
      await limit(pool,'login-email',address,20,15);
      const result = await pool.query('SELECT id,nombre,email,telefono,colonia,password,auth_version FROM usuarios WHERE lower(btrim(email))=$1', [address]);
      const user = result.rows.length === 1 ? result.rows[0] : null;
      const valid = await bcrypt.compare(body.password, user?.password || dummyHash);
      if (!user?.password || !valid) throw authError(401, 'Correo o contraseña incorrectos');
      return issueSession(user);
    },
    async forgot(body) {
      const address = email(body?.email);
      if (!validEmail(address)) throw authError(400, 'Escribe un correo válido');
      if (!mailer.ready()) throw authError(503, 'La recuperación por correo aún no está habilitada.');
      await limit(pool, 'recovery-email', address, 3, 60);
      const code = String(crypto.randomInt(0,100000000)).padStart(8,'0');
      const codeHash = hashCode(address, code);
      const result = await pool.query(`SELECT id FROM usuarios WHERE lower(btrim(email))=$1`, [address]);
      if (result.rows.length !== 1) return genericRecovery;
      const id = result.rows[0].id;
      await pool.query(`INSERT INTO auth_resets(usuario_id,code_hash,expires_at,attempts) VALUES($1,$2,NOW()+INTERVAL '15 minutes',0)
        ON CONFLICT(usuario_id) DO UPDATE SET code_hash=EXCLUDED.code_hash,expires_at=EXCLUDED.expires_at,attempts=0`, [id,codeHash]);
      // SMTP latency must not reveal whether the address exists. Delivery is best effort;
      // a failed send invalidates only this code, never a newer resend.
      void Promise.resolve().then(() => mailer.sendCode(address, code)).catch(async error => {
        console.error('Recovery delivery failed:', error.code || error.name);
        await pool.query('DELETE FROM auth_resets WHERE usuario_id=$1 AND code_hash=$2',[id,codeHash]);
      }).catch(() => { console.error('Recovery delivery cleanup unavailable'); });
      return genericRecovery;
    },
    async reset(body) {
      const address = email(body?.email);
      if (!validEmail(address) || typeof body?.code !== 'string' || !/^\d{8}$/.test(body.code) || !validPassword(body?.password)) throw authError(400, 'Revisa el correo, el código de 8 dígitos y la nueva contraseña');
      const nextPassword = await bcrypt.hash(body.password,10);
      const success = await transaction(pool, async client => {
        const { rows } = await client.query(`SELECT r.*,r.expires_at>NOW() AS valid FROM auth_resets r JOIN usuarios u ON u.id=r.usuario_id
          WHERE lower(btrim(u.email))=$1 FOR UPDATE OF r`,[address]);
        const row = rows.length === 1 ? rows[0] : null;
        if (!row || !row.valid || row.attempts >= 5) return false;
        const actual = Buffer.from(hashCode(address,body.code),'hex'), expected = Buffer.from(row.code_hash,'hex');
        if (actual.length !== expected.length || !crypto.timingSafeEqual(actual,expected)) {
          await client.query('UPDATE auth_resets SET attempts=attempts+1 WHERE id=$1',[row.id]); return false;
        }
        await client.query('UPDATE usuarios SET password=$1,auth_version=auth_version+1,push_token=NULL WHERE id=$2',[nextPassword,row.usuario_id]);
        await client.query('DELETE FROM auth_resets WHERE id=$1',[row.id]);
        return true;
      });
      if (!success) throw authError(400, 'El código no es válido, ya se utilizó o caducó. Solicita otro si es necesario.');
      return { message: 'Contraseña actualizada. Inicia sesión con tu nueva contraseña.' };
    },
  };
}
module.exports = { createPasswordAuth };
