# aquapaz-api

API Express/PostgreSQL. Node 20; configure DATABASE_URL, JWT_SECRET and optionally JWT_EXPIRES_IN (default 1h). Never commit credentials.

## Apply the synchronization update

1. Install dependencies: `npm install`.
2. Back up PostgreSQL and run `npm run migrate` against the intended database before deploying this API. The versioned baseline creates missing application tables; the synchronization migration updates existing tables.
3. Deploy the API, then release the updated app. Older apps cannot create reports because authenticated requests and client_id are now required.

The migration adds a unique retry key per report author and notification ownership without deleting existing data. Legacy notifications have no known recipient and are excluded from client access until their recipient is assigned through a trusted administrative process.

Reports and confirmations require `Authorization: Bearer <JWT>`. The server derives the author from JWT and restricts access to the user's colonia. POST /api/reportes requires client_id (8-128 letters, digits, underscores or hyphens); repeat the same payload and key after a timeout to recover the original report ID. Reusing a key with a different payload returns 409.

Each user can confirm a report once and cannot confirm their own report. Report locks serialize confirmations; legacy duplicate rows count only once per identified user. Notifications are readable and mutable only by their recipient; client creation is forbidden.

## Verification

Run `npm test`. Route tests use injected database/JWT adapters and do not contact production. Real PostgreSQL migration, concurrent database operations and remote push delivery still require integration testing in staging.

Push is best effort after report persistence. A crash between saving and sending can leave a report without a push; retrying the report does not resend it. Guaranteed delivery requires a transactional outbox in a later change.

## Recreate the database

`npm run migrate` creates missing application tables and applies the synchronization schema without deleting data.

`npm run migrate:fresh -- --force` deletes and recreates only the four AquaPaz tables in public. It requires an explicit force flag, locks the tables, saves and verifies a local data backup under backups/, and commits all DDL in one transaction. Unexpected external dependencies cause rollback because DROP does not use CASCADE. No seed data is inserted.

Old sequence values are retained to avoid reusing IDs referenced by cached reports or existing JWTs. Tables are empty after fresh, but IDs may start above 1.

Backups contain personal information, password hashes and push tokens. They are ignored by Git and must remain private. To recover into an empty matching schema, run:

`npm run db:restore -- backups/NAME.json`

Restore refuses nonempty tables and runs in a single transaction. It restores data and sequence values, not a general PostgreSQL dump of unrelated objects. Clear old sessions and local app storage after resetting the remote database.

## Water map

Authenticated GET /api/reportes/mapa returns citywide colony aggregates, without user IDs, comments or push tokens. Only water reports in the last 24 hours count, with the latest report per user/colony chosen by date then ID. The endpoint returns no_agua, baja_presion, tengo_agua, ultima_actualizacion and expira (the earliest contributor expiry) per colony. Raw report routes remain restricted to the user's own colony.

Run the PostgreSQL integration test with RUN_DB_TESTS=1 and `node --test tests/map-integration.test.js`. It uses a temporary table and rolls back; real rows are not modified.
# Servicio de pipas

`npm run migrate` incluye `002_pipas.sql` y `003_pipas_cotizaciones.sql`: crea perfiles, pedidos y cotizaciones sin borrar datos. `npm start` ejecuta la migración mediante `prestart` antes de abrir el servidor; si la migración falla no inicia la API. Las migraciones se serializan con un bloqueo de PostgreSQL y tienen límites de espera. Desplegar el código actualizado habilita los endpoints autenticados bajo `/api/pipas`:

- `GET/POST /pedidos`: consultar las solicitudes propias y crear una con `client_id`, colonia, dirección, referencias, teléfono, litros y coordenadas. Un identificador repetido devuelve la solicitud original si los datos coinciden.
- `POST /pedidos/:id/cancelar`: el cliente cancela antes de iniciar el viaje.
- `GET/POST /operador`: perfil propio, entrega activa y registro de pipa con nombre, placas, teléfono y capacidad.
- `PUT /operador/disponibilidad`: activar o desactivar la recepción de pedidos.
- `GET /disponibles`: solicitudes compatibles con la capacidad; no revela datos de contacto ni ubicación exacta antes de aceptar.
- `POST /pedidos/:id/aceptar`: asignación atómica a un operador disponible, con una sola entrega activa.
- `PUT /pedidos/:id/estado`: el operador asignado avanza de asignada a en_camino, en_sitio y completada, en ese orden.
- `PUT /pedidos/:id/cotizacion`: el operador asignado envía `precio_centavos` (1 a 10,000,000), `llegada_estimada_minutos` (1 a 1440), `notas` y la `version` actual. La versión aumenta; repetir el mismo envío recupera la cotización sin duplicarla. Se puede actualizar antes de su aceptación.
- `POST /pedidos/:id/aceptar-precio`: el cliente confirma la `version` y el `precio_centavos` exactos que revisó. Un precio desactualizado no puede aceptarse. Tras aceptarlo se bloquean cambios de importe y condiciones.
- `POST /pedidos/:id/rechazar-precio`: el cliente rechaza la `version` vigente y cancela el pedido antes del viaje, conservando la cotización en el historial. Puede crear otra solicitud.

El viaje no puede iniciarse hasta que el cliente acepte el precio; la restricción se aplica en la API, también a versiones anteriores de la app. Importes en centavos enteros de MXN y estimaciones del operador, sin cargos automáticos. El registro de operadores es directo; no acredita verificación de proveedores. GPS en segundo plano y cobros quedan pendientes. Los respaldos y `migrate:fresh` incluyen las tablas; **no se ejecuta fresh para activar este módulo**. La restauración sigue aceptando respaldos anteriores sin tablas de pipas.

## Notificaciones de pipas

`005_pipas_notificaciones.sql` agrega metadatos y una cola de push en `notificaciones`. Un trigger guarda los eventos en la misma transacción del pedido: nueva solicitud para operadores disponibles, compatibles y sin entrega activa; asignación, cotización y estados para el cliente; aceptación del precio y cancelación para el operador asignado. El índice de destinatario/pedido/evento impide duplicados y las actualizaciones de GPS no generan avisos. La migración no crea eventos históricos. La restauración desactiva el trigger mediante `SET LOCAL aquapaz.restoring='on'` y restaura el historial sin reenviar push de respaldos.

- `GET /api/notificaciones`: últimos 200 avisos propios, con `pedido_id`, `destinatario`, `evento` y `titulo`. No expone tokens ni metadatos de entrega push.
- `PUT /api/notificaciones/:id/leida` y `DELETE /api/notificaciones/:id`: acciones restringidas al destinatario.
- `GET /api/pipas/pedidos/:id`: datos del pedido solo para el cliente u operador asignado. Una solicitud aún disponible muestra únicamente id, colonia, volumen, fecha y estado al operador elegible.
- `POST /api/auth/push-token`: registra un token Expo válido para la cuenta autenticada y desvincula ese dispositivo de otras cuentas de forma atómica. Un dispositivo activo por cuenta.
- `DELETE /api/auth/push-token`: elimina solo el token enviado y perteneciente a esa cuenta; no elimina un token posterior distinto.

La API consulta la cola cada 15 segundos, reclama hasta cinco filas con bloqueo y lease para evitar envíos concurrentes y usa el servicio push de Expo con timeout. Reintenta errores temporales con espera creciente; consulta recibos 15 minutos después y limpia `DeviceNotRegistered` sin afectar un token de reemplazo. Un ticket aceptado no se presenta como entrega confirmada. Sin token o después de una hora el evento permanece en el historial pero no se envía. Un timeout después de la aceptación remota puede provocar un push repetido; la bandeja conserva un solo evento. Si el proyecto activa seguridad push, configura `EXPO_ACCESS_TOKEN` en Railway (nunca en la app).

Se necesitan credenciales APNs/FCM y una compilación de desarrollo para validar la entrega física. Las pruebas usan un transporte simulado y esquemas PostgreSQL aislados; no envían push reales ni crean pedidos de producción.

## Ubicación GPS de pipas

`004_pipas_ubicacion.sql` agrega columnas opcionales sin borrar registros. Solo se conserva la última posición del pedido, no un historial de recorridos.

- `PUT /api/pipas/pedidos/:id/ubicacion`: solo el operador asignado envía `latitud`, `longitud`, `precision` (metros, opcional) y `observada_en` (timestamp GPS en milisegundos) durante `en_camino` o `en_sitio`. Acepta muestras de hasta 120 segundos y 30 segundos de tolerancia futura; una muestra fuera de orden no reemplaza una más nueva.
- `GET /api/pipas/pedidos/:id/ubicacion`: solo el cliente del pedido y su operador pueden leer la posición. Incluye hora del servidor, estado y fecha real de medición.
- `DELETE /api/pipas/pedidos/:id/ubicacion`: el operador limpia la última posición al detener la publicación. Al completar la entrega la API elimina esos datos y bloquea nuevos envíos.

El GPS funciona con consentimiento del operador y la app activa. El cliente consulta cada 10 segundos y marca como antiguas las posiciones con más de 45 segundos, también cuando falla la red. No se encolan coordenadas offline.

Las pruebas PostgreSQL optativas (`RUN_DB_TESTS=1 npm test`) crean un esquema aislado dentro de una transacción y lo revierten; no crean operadores ni pedidos reales.
