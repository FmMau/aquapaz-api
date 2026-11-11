// Explicit local volume benchmark: real migrations, route SQL and JWT middleware; no Railway,
// push delivery, SMTP, or production credentials are used.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { PGlite } = require('@electric-sql/pglite');
const { schemaSql } = require('./database-tools');
const allColonies = require('../src/data/colonias.json');

function options(args) {
  const result = { users: 1000, reports: 10000, requests: 120, concurrency: 10, colonies: allColonies.length, candidateIndexes: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--candidate-indexes') { result.candidateIndexes = true; continue; }
    const key = args[i].replace(/^--/, '');
    const value = Number(args[++i]);
    if (!(key in result) || key === 'candidateIndexes' || !Number.isSafeInteger(value) || value < 1) throw new Error('Use --users, --reports, --requests, --concurrency, --colonies followed by a positive integer, or --candidate-indexes');
    result[key] = value;
  }
  if (result.users > 10000 || result.reports > 100000 || result.requests > 10000 || result.concurrency > 100 || result.colonies > allColonies.length) throw new Error('Requested size exceeds the local volume-test limits');
  return result;
}
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
const round = n => Math.round(n * 100) / 100;

async function main() {
  const config = options(process.argv.slice(2));
  const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');
  const directory = path.join(__dirname, '../tmp/volume-test', runId);
  fs.mkdirSync(directory, { recursive: true });
  const db = new PGlite(path.join(directory, 'database'));
  const colonies = allColonies.slice(0, config.colonies);
  const secret = crypto.randomBytes(32).toString('hex');
  let server, queryCount = 0;
  const pool = { query: async (sql, args) => { queryCount++; return db.query(sql, args); } };
  // Transactional route writes are deliberately excluded from concurrent tests:
  // PGlite uses one connection and cannot model PostgreSQL lock contention.
  function load(file, dependencies) {
    const context = { module: { exports: {} }, console, Buffer,
      process: { env: { JWT_SECRET: secret } },
      fetch: () => { throw new Error('External push delivery is disabled in this local test'); },
      require: name => name in dependencies ? dependencies[name] : require(name) };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), context, { filename: file });
    return context.module.exports;
  }
  try {
    const seedStart = performance.now();
    await db.exec(schemaSql());
    await db.query(`INSERT INTO usuarios(id,nombre,email,telefono,colonia)
      SELECT i, 'Vecino de prueba '||i, 'vecino.'||i||'@aquapaz.test', '6120000000',
        ($2::jsonb ->> ((i-1) % $3)) FROM generate_series(1,$1::int) i`,
    [config.users, JSON.stringify(colonies), colonies.length]);
    // Leave push_token NULL. Real database triggers create the inbox entries,
    // but none of these fictional accounts can receive an external push.
    await db.query(`INSERT INTO reportes(colonia,tipo,estado,comentario,usuario_id,client_id,fecha)
      SELECT u.colonia, CASE WHEN i%10=0 THEN 'fuga' ELSE 'agua' END,
        CASE i%3 WHEN 0 THEN 'no_agua' WHEN 1 THEN 'baja_presion' ELSE 'tengo_agua' END,
        CASE i%3 WHEN 0 THEN 'Sin suministro durante la mañana'
          WHEN 1 THEN 'El agua llega con poca presión' ELSE 'Se restableció el suministro' END,
        u.id, 'volumen-'||i, (NOW() AT TIME ZONE 'UTC')-((i%72)*INTERVAL '1 hour')
      FROM generate_series(1,$1::int) i JOIN usuarios u ON u.id=((i-1)%$2)+1`, [config.reports, config.users]);
    await db.exec("SELECT setval('usuarios_id_seq',(SELECT MAX(id) FROM usuarios)); SELECT setval('reportes_id_seq',(SELECT MAX(id) FROM reportes)); ANALYZE;");
    if (config.candidateIndexes) {
      // Experimental indexes apply only to this isolated test database.
      await db.exec(`CREATE INDEX volume_reportes_colonia_fecha ON reportes(colonia,fecha DESC,id DESC);
        CREATE INDEX volume_notificaciones_usuario_id ON notificaciones(usuario_id,id DESC);
        ANALYZE reportes; ANALYZE notificaciones;`);
    }
    const counts = (await db.query(`SELECT (SELECT COUNT(*) FROM usuarios)::int AS users,
      (SELECT COUNT(*) FROM reportes)::int AS reports,
      (SELECT COUNT(*) FROM notificaciones)::int AS notifications,
      (SELECT COUNT(push_token) FROM usuarios)::int AS push_tokens`)).rows[0];
    if (counts.users !== config.users || counts.reports !== config.reports || counts.push_tokens !== 0) throw new Error('Seed verification failed');
    console.log('Seed complete:', JSON.stringify(counts));
    const seedMs = round(performance.now() - seedStart);
    const auth = load('middlewares/auth.middleware.js', { '../database/db': pool });
    const app = express(); app.use(express.json());
    const dependencies = { '../database/db': pool, '../middlewares/auth.middleware': auth };
    app.use('/api/reportes', load('routes/reportes.routes.js', dependencies));
    app.use('/api/notificaciones', load('routes/notificaciones.routes.js', dependencies));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const tokens = Array.from({ length: config.users }, (_, i) => jwt.sign({ id: i + 1, v: 0 }, secret, { expiresIn: '1h' }));
    const results = [];
    for (const endpoint of ['/api/reportes/mapa', '/api/reportes', '/api/notificaciones']) {
      const request = async index => {
        const response = await fetch(base + endpoint, { headers: { Authorization: 'Bearer ' + tokens[index % tokens.length] }, signal: AbortSignal.timeout(30000) });
        const text = await response.text();
        if (response.status !== 200) throw new Error('HTTP ' + response.status);
        const body = JSON.parse(text);
        if (endpoint.endsWith('/mapa')) {
          if (!Array.isArray(body.colonias) || body.colonias.some(row => 'usuario_id' in row || 'email' in row)) throw new Error('Map aggregation/privacy check failed');
        } else if (!Array.isArray(body)) throw new Error('Expected an array');
        return Buffer.byteLength(text);
      };
      // Warm the route, then measure a sequential baseline and an HTTP burst.
      await request(0);
      for (const concurrency of [1, config.concurrency].filter((v, i, a) => a.indexOf(v) === i)) {
        const timings = [], errors = {}, sizes = [];
        let next = 0;
        const beforeQueries = queryCount, started = performance.now();
        await Promise.all(Array.from({ length: concurrency }, async () => {
          for (;;) {
            const index = next++; if (index >= config.requests) return;
            const start = performance.now();
            try { sizes.push(await request(index)); }
            catch (error) { const key = error.message; errors[key] = (errors[key] || 0) + 1; }
            timings.push(performance.now() - start);
          }
        }));
        const elapsed = performance.now() - started;
        timings.sort((a, b) => a - b);
        const result = { endpoint, concurrency, requests: timings.length, failures: Object.values(errors).reduce((a,b)=>a+b,0), errors,
          p50Ms: round(percentile(timings,.5)), p95Ms: round(percentile(timings,.95)), maxMs: round(timings.at(-1)),
          requestsPerSecond: round(timings.length / (elapsed / 1000)), queriesPerRequest: round((queryCount-beforeQueries)/timings.length),
          averageResponseBytes: round(sizes.reduce((a,b)=>a+b,0)/Math.max(1,sizes.length)) };
        results.push(result); console.log(JSON.stringify(result));
      }
    }
    const unauthorized = await fetch(base + '/api/reportes/mapa');
    if (unauthorized.status !== 401) throw new Error('Unauthenticated access was not rejected');
    const report = { runId, config, counts, seedMs, results, unauthenticatedStatus: unauthorized.status,
      limitations: 'Local PGlite, one database connection, HTTP on loopback. Not a Railway/PostgreSQL capacity test or 1000 simultaneous sessions. Real push and external services disabled.',
      memory: process.memoryUsage() };
    fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify(report,null,2));
    const markdown = `# AquaPaz: prueba local de volumen\n\n${counts.users} usuarios, ${counts.reports} reportes y ${counts.notifications} avisos generados por los triggers reales. Preparación: ${(seedMs/1000).toFixed(2)} s.\n\n` +
      '| Ruta | Concurrencia HTTP | Peticiones | Fallos | p50 ms | p95 ms | Máx. ms | Peticiones/s | SQL/petición |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n' +
      results.map(r=>`| ${r.endpoint} | ${r.concurrency} | ${r.requests} | ${r.failures} | ${r.p50Ms} | ${r.p95Ms} | ${r.maxMs} | ${r.requestsPerSecond} | ${r.queriesPerRequest} |`).join('\n') +
      '\n\nSin tokens push ni solicitudes a Railway, Firebase, SMTP o Expo. Rutas y middleware JWT reales. Acceso sin sesión: HTTP 401.\n\n' + report.limitations + '\n';
    fs.writeFileSync(path.join(directory, 'report.md'), markdown);
    console.log('Report:', path.join(directory, 'report.md'));
    if (results.some(r=>r.failures)) process.exitCode = 1;
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await db.close();
  }
}
main().catch(error => { console.error('Volume test failed:', error.message); process.exitCode = 1; });
