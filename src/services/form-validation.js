// Keep these contract rules aligned with AquaPaz/src/services/form-validation.js.
const control = /[\u0000-\u001f\u007f]/;
const multilineControl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const validFormText = (value,min,max,multiline=false) => typeof value==='string' && value.trim().length>=min && value.trim().length<=max && !(multiline?multilineControl:control).test(value);
const validFormPhone = value => typeof value==='string' && value.trim().length<=20 && /^\+?[\d ()-]+$/.test(value.trim()) && /^\d{10,15}$/.test(value.replace(/\D/g,''));
const validFormVolume = value => Number.isSafeInteger(value) && value>=1 && value<=100000;
function operatorFieldErrors(body={}) {
  const errors={};
  if(!validFormText(body?.nombre,3,100))errors.nombre='Escribe el nombre de la pipa o servicio (de 3 a 100 caracteres).';
  if(!validFormText(body?.placas,3,20)||!(/^[a-zA-Z0-9 -]+$/).test(body.placas.trim()))errors.placas='Escribe las placas (de 3 a 20 letras, números, espacios o guiones).';
  if(!validFormPhone(body?.telefono))errors.telefono='Escribe un teléfono de 10 a 15 dígitos.';
  if(!validFormVolume(body?.capacidad))errors.capacidad='Indica una capacidad de 1 a 100,000 litros enteros.';
  return errors;
}
function quoteFieldErrors(body={}) {
  const errors={};
  if(!validFormVolume(body?.litros))errors.litros='Indica de 1 a 100,000 litros enteros.';
  if(typeof body?.latitud!=='number'||!Number.isFinite(body.latitud)||Math.abs(body.latitud)>90||typeof body?.longitud!=='number'||!Number.isFinite(body.longitud)||Math.abs(body.longitud)>180)errors.ubicacion='Selecciona un punto de entrega válido en el mapa o usa tu ubicación actual.';
  return errors;
}
function deliveryFieldErrors(body={},colonies) {
  const errors=quoteFieldErrors(body);
  if(!validFormText(body?.direccion,5,300))errors.direccion='Escribe calle y número (de 5 a 300 caracteres).';
  if(!validFormText(body?.referencias??'',0,500,true))errors.referencias='Las referencias admiten hasta 500 caracteres. Revisa que el texto no tenga símbolos no válidos.';
  if(!validFormText(body?.colonia,2,100)||(colonies&&!colonies.includes(body.colonia.trim())))errors.colonia='Selecciona una colonia válida en Mi perfil.';
  if(!validFormPhone(body?.telefono))errors.telefono='Guarda un teléfono de 10 a 15 dígitos en Mi perfil.';
  return errors;
}
function profileFieldErrors(body={},colonies=[]) {
  const errors={};
  if(!validFormText(body?.nombre,1,100))errors.nombre='Escribe un nombre de hasta 100 caracteres.';
  if(!validFormPhone(body?.telefono))errors.telefono='Escribe un teléfono de 10 a 15 dígitos.';
  if(typeof body?.colonia!=='string'||!colonies.includes(body.colonia.trim()))errors.colonia='Selecciona una colonia del catálogo.';
  return errors;
}

module.exports={validFormText,validFormPhone,validFormVolume,operatorFieldErrors,quoteFieldErrors,deliveryFieldErrors,profileFieldErrors};
