# Configuración de acceso de AquaPaz

El código incluye acceso con contraseña, recuperación por código y acceso con Google/Apple. Las credenciales externas se configuran exclusivamente en el backend; no uses variables `EXPO_PUBLIC_*` para secretos. `.env.example` muestra los nombres necesarios sin credenciales reales.

## Activar la API

1. Configura `DATABASE_URL`, un `JWT_SECRET` privado y `AUTH_PUBLIC_URL` con el origen HTTPS de la API, sin `/api` ni otras rutas.
2. Aplica `npm run migrate`. `006_auth.sql` agrega tablas de recuperación, límites de intentos, identidades y códigos temporales, además de `usuarios.auth_version`. No borra ni fusiona cuentas.
3. Despliega el código y verifica `GET /api/auth/options`. Devuelve únicamente indicadores `google`, `apple` y `recovery`, nunca secretos.

`npm start` aplica las migraciones antes de iniciar. El frontend puede mostrar la pantalla nueva en Expo Go, pero los endpoints nuevos requieren esta API. Las cuentas existentes conservan su contraseña y token hasta su expiración; recuperar la contraseña incrementa la versión de autenticación y revoca las sesiones anteriores.

## Correo de recuperación

Configura una cuenta SMTP transaccional mediante `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` y `AUTH_MAIL_FROM`. Usa un remitente autorizado por tu proveedor. Normalmente 587 usa STARTTLS y `SMTP_SECURE=false`; 465 usa TLS directo y `SMTP_SECURE=true`.

El usuario solicita un código de ocho dígitos desde «¿Olvidaste tu contraseña?» y lo introduce en la app. Caduca en 15 minutos, admite cinco intentos y solo se usa una vez. Reenviar invalida el código anterior. Las respuestas no revelan si el correo está registrado y no muestran códigos en la API ni en logs. Si falta la configuración SMTP, el endpoint informa que la recuperación no está habilitada.

No se envían correos al iniciar o desplegar la API. El envío ocurre exclusivamente al solicitar recuperación. Para verificar el envío real, solicita un código desde la app con una cuenta tuya cuando hayas configurado el servicio.

La respuesta no espera al SMTP y aplica un tiempo mínimo uniforme para las solicitudes válidas; el envío es de mejor esfuerzo. Si falla, se invalida ese código y se registra únicamente el tipo de error. Un reinicio durante el envío puede requerir solicitar otro código; no se afirma entrega garantizada.

## Google

En Google Cloud configura la pantalla de consentimiento para AquaPaz y crea un cliente OAuth de tipo **Aplicación web**. Si está en modo de pruebas, agrega las cuentas de prueba que usarás. Guarda el ID y secreto en `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`.

Registra como URI de redirección autorizada:

`https://aquapaz-api-production.up.railway.app/api/auth/social/callback/google`

Si cambias el origen de la API, usa ese origen en el callback y en `AUTH_PUBLIC_URL`. El backend abre el flujo con state, nonce y PKCE, intercambia el código y verifica firma, emisor, audiencia, caducidad y correo confirmado. Solo solicita identidad, correo y nombre; no almacena tokens de acceso ni de actualización del proveedor.

Documentación: [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect).

## Apple

En Apple Developer habilita Sign in with Apple para AquaPaz y configura un **Services ID** asociado a tu App ID. Registra el dominio público de la API y el retorno:

`https://aquapaz-api-production.up.railway.app/api/auth/social/callback/apple`

Configura `APPLE_CLIENT_ID` con ese Services ID, `APPLE_TEAM_ID`, `APPLE_KEY_ID` y `APPLE_PRIVATE_KEY` con la clave privada PEM `.p8`. Si la variable se configura en una sola línea, usa separadores literales `\n`; el backend los convierte a saltos de línea. Protege esa clave y no la subas al repositorio.

El servidor genera un client secret ES256 de corta duración para el intercambio y verifica el ID token RS256 de Apple. Apple puede devolver un correo privado relay; el correo confirmado del proveedor identifica el registro nuevo. El nombre y los datos de contacto se completan en AquaPaz.

Documentación: [Sign in with Apple REST API](https://developer.apple.com/documentation/signinwithapplerestapi).

## Regreso a la app

Este flujo usa `aquapaz://oauth`, ya definido por el esquema de la app. Se abre mediante `expo-web-browser` y protege el código de retorno con una segunda comprobación PKCE. La URL de regreso contiene un código temporal, nunca el JWT de AquaPaz. Se intercambia una sola vez con el verificador que conserva la app en memoria.

Prueba Google y Apple en un build de desarrollo de AquaPaz o en la app instalada. Los botones están deshabilitados en Expo Go o si el proveedor no está configurado. El login por contraseña, el registro, el selector y los códigos de recuperación sí pueden probarse en Expo Go.

Documentación: [Autenticación con Expo](https://docs.expo.dev/guides/authentication/).

## Vincular y crear cuentas

Si ya está registrada la identidad del proveedor, se inicia sesión con su cuenta de AquaPaz. Si el correo coincide con una cuenta existente, se requiere su contraseña para vincularla; no hay fusiones automáticas por correo. Si no existe una cuenta, se solicitan nombre, teléfono y colonia, y después se crea la cuenta social sin una contraseña ficticia.

Los correos se normalizan sin alterar las contraseñas. Las altas bloquean por correo normalizado para evitar duplicados concurrentes y por diferencias de mayúsculas. Si existen duplicados antiguos, no se elige ni se fusiona una cuenta automáticamente: deben revisarse antes de completar ese acceso.

## Pruebas

`npm test` ejecuta las pruebas locales. Para la integración de autenticación, configura `RUN_DB_TESTS=1` y ejecuta `node --test tests/auth-integration.test.js`. La prueba utiliza tablas y secuencias temporales, revierte la transacción y simula correo y proveedores. No modifica cuentas reales ni envía mensajes. Las pruebas de firma usan claves aisladas.

El envío SMTP real, el consentimiento real de Google/Apple y la presentación en un iPhone requieren las credenciales correspondientes y un dispositivo; las pruebas simuladas no certifican esos pasos.
