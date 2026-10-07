const colonies = new Set(require('../data/colonias.json'));
const email = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validEmail = value => {
  if (typeof value !== 'string' || value.length > 120 || value.split('@').length !== 2) return false;
  const [local,domain] = value.split('@');
  return local.length <= 64 && /^[a-z0-9.!#$%&'*+/=?^_{|}~-]+$/i.test(local) && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..') &&
    domain.split('.').length >= 2 && domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
};
const validPassword = value => typeof value === 'string' && value.length >= 8 && value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 72;
const profileError = body => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Datos inválidos';
  if (typeof body.nombre !== 'string' || !body.nombre.trim() || body.nombre.trim().length > 100 || /[\u0000-\u001f\u007f]/.test(body.nombre)) return 'Escribe un nombre de hasta 100 caracteres';
  if (typeof body.telefono !== 'string' || body.telefono.trim().length > 20 || !/^\+?[\d ()-]+$/.test(body.telefono.trim()) || !/^\d{10,15}$/.test(body.telefono.replace(/\D/g, ''))) return 'Escribe un teléfono de 10 a 15 dígitos';
  if (typeof body.colonia !== 'string' || !colonies.has(body.colonia.trim())) return 'Selecciona una colonia del catálogo';
  return null;
};
const publicUser = user => ({ id: user.id, nombre: user.nombre, email: user.email, telefono: user.telefono, colonia: user.colonia });
const authError = (status, message) => Object.assign(new Error(message), { status });
module.exports = { email, validEmail, validPassword, profileError, publicUser, authError };
