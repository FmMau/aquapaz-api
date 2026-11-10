const {test}=require('node:test');
const assert=require('node:assert/strict');
const {operatorFieldErrors,deliveryFieldErrors,profileFieldErrors,quoteFieldErrors}=require('../src/services/form-validation');
const {createPasswordAuth}=require('../src/services/password-auth');
test('API validators reject blank, malformed and oversized fields with explicit field names',()=>{
  assert.deepEqual(Object.keys(operatorFieldErrors({})).sort(),['capacidad','nombre','placas','telefono']);
  assert.equal(Object.keys(operatorFieldErrors({nombre:'Agua La Paz',placas:'ABC-123',telefono:'+52 612 123 4567',capacidad:7500})).length,0);
  const errors=deliveryFieldErrors({litros:'3500',direccion:' ',referencias:'bad\u0000text',telefono:'1234567890123456',colonia:'Inventada',latitud:null,longitud:180},['Centro']);
  for(const key of ['litros','direccion','referencias','telefono','colonia','ubicacion'])assert.ok(errors[key]);
  assert.equal(Object.keys(profileFieldErrors({nombre:'Persona',telefono:'+52 612 123 4567',colonia:'Centro'},['Centro'])).length,0);
  for(const body of [null,[],{},'text',42])assert.equal(Object.keys(quoteFieldErrors(body)).length,2);
});
test('login and registration validation return field errors before any database access',async()=>{
  const auth=createPasswordAuth({pool:{query:()=>assert.fail('Unexpected SQL'),connect:()=>assert.fail('Unexpected transaction')},mailer:{}});
  await assert.rejects(auth.login({email:'bad',password:'   '}),error=>error.status===400&&!!error.fields.email&&!!error.fields.password);
  await assert.rejects(auth.register(null),error=>error.status===400&&!!error.fields.nombre&&!!error.fields.telefono&&!!error.fields.email&&!!error.fields.password);
  await assert.rejects(auth.reset({email:'bad',code:'abc',password:'short'}),error=>error.status===400&&!!error.fields.code&&!!error.fields.password);
});
