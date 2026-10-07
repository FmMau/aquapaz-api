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
