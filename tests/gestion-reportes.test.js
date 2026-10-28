const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('management authorization, filtering, transitions, conflicts and audit run on isolated PostgreSQL', async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const db = new PGlite();
  let server;
  try {
    const migration = fs.readFileSync(path.join(__dirname, '../migrations/007_reportes_gestion.sql'), 'utf8');
    await db.exec(fs.readFileSync(path.join(__dirname, '../migrations/000_base_schema.sql'), 'utf8'));
    await db.exec('ALTER TABLE usuarios ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0');
    await db.exec(migration); await db.exec(migration);
    await db.exec(`INSERT INTO usuarios (id, nombre, colonia) VALUES (1,'Ciudadano','Centro'),(2,'Gestor A','Centro'),(3,'Gestor B','Otra'),(4,'Consulta','Otra');
      INSERT INTO gestion_roles (usuario_id,rol) VALUES (2,'gestor'),(3,'gestor'),(4,'consulta');
      INSERT INTO reportes (id,colonia,tipo,estado,comentario,usuario_id,fecha) VALUES
      (1,'Centro','agua','no_agua','Sin servicio',1,'2026-10-27 12:00:00'),
      (2,'Otra','fuga','baja_presion','Tubería dañada',1,'2026-10-26 12:00:00');`);
    let failHistory = false;
    const query = async (sql, args) => {
      if (failHistory && sql.includes('INSERT INTO reporte_atenciones')) throw new Error('Injected history failure');
      return db.query(sql,args);
    };
    const pool = { query, connect: async () => ({ query, release() {} }) };
    const load = (file, dependencies) => {
      const context = { module: { exports: {} }, process: { env: { JWT_SECRET: 'test-secret' } }, console: { error() {} }, require: name => {
        if (Object.hasOwn(dependencies, name)) return dependencies[name];
        throw new Error(name);
      } };
      vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src', file),'utf8'),context);
      return context.module.exports;
    };
    const auth = load('middlewares/auth.middleware.js', { jsonwebtoken: jwt, '../database/db': pool });
    const router = load('routes/gestion-reportes.routes.js', { express, '../database/db': pool, '../middlewares/auth.middleware': auth });
    const app = express(); app.use(express.json()); app.use('/api/gestion/reportes', router);
    server = await new Promise(resolve => { const s = app.listen(0,'127.0.0.1',()=>resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/gestion/reportes`;
    const call = async (id, route = '', method = 'GET', body) => {
      const response = await fetch(base + route, { method, headers: { Authorization: `Bearer ${jwt.sign({ id, rol:'gestor' }, 'test-secret', {algorithm:'HS256'})}`, 'Content-Type':'application/json' }, ...(body ? {body:JSON.stringify(body)} : {}) });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await fetch(base)).status,401);
    for (const route of ['', '/contexto', '/resumen', '/1']) assert.equal((await call(1,route)).status,403);
    let summary = (await call(4, '/resumen')).body;
    assert.equal(summary.resumen.pendientes, 2); assert.equal(summary.resumen.sin_responsable, 2);
    assert.equal(summary.resumen.en_atencion, 0); assert.equal(summary.pendientes[0].id, 2);
    assert.deepEqual(summary.en_atencion, []);
    const ctx = await call(4,'/contexto');
    assert.equal(ctx.body.permisos.gestionar,false);
    assert.deepEqual(ctx.body.responsables.map(r=>r.id),[2,3]);
    const update = { version:0, estado_atencion:'en_revision',responsable_id:2,nota:'Revisión inicial' };
    assert.equal((await call(4,'/1/atencion','PUT',update)).status,403);
    let list = await call(2);
    assert.equal(list.body.resumen.total,2); assert.equal(list.body.reportes[0].id,1);
    assert.equal(list.body.reportes[0].password,undefined);
    list = await call(2,'?colonia=Otra&tipo=fuga&q=dañada&desde=2026-10-26&hasta=2026-10-26');
    assert.equal(list.body.resumen.total,1); assert.equal(list.body.reportes[0].id,2);
    assert.equal((await call(2,'?q=%27%20OR%201%3D1--')).body.resumen.total,0);
    assert.equal((await call(2,'?q=%25')).body.resumen.total,0);
    assert.equal((await call(2,'?limite=1&pagina=2')).body.reportes[0].id,2);
    for (const q of ['pendientes=false','pendientes[x]=true','estado_atencion=invalid','desde=2026-02-30','desde=2026-10-28&hasta=2026-10-27','limite=101','q[x]=bad','responsable_id=0','pagina=1.5','unknown=1']) assert.equal((await call(2,'?'+q)).status,400,q);
    assert.equal((await call(2,'/abc')).status,400);
    assert.equal((await call(2,'/99')).status,404);
    for (const patch of [{responsable_id:1},{nota:' '},{version:-1},{actor_id:999},{estado_atencion:'resuelto'}]) assert.equal((await call(2,'/1/atencion','PUT',{...update,...patch})).status,400);
    let result = await call(2,'/1/atencion','PUT',update);
    assert.equal(result.status,200); assert.equal(result.body.version_atencion,1);
    assert.equal((await call(3,'/1/atencion','PUT',update)).status,409);
    const detail = (await call(4,'/1')).body;
    assert.equal(detail.reporte.estado,'no_agua'); assert.equal(detail.historial.length,1);
    assert.equal(detail.historial[0].actor_id,2); assert.equal(detail.historial[0].responsable_nuevo_id,2);
    assert.equal(detail.historial[0].nota,'Revisión inicial');
    assert.equal((await call(2,'/1/atencion','PUT',{...update,version:1,estado_atencion:'en_atencion',responsable_id:null})).status,400);
    result = await call(3,'/1/atencion','PUT',{...update,version:1,estado_atencion:'en_atencion',responsable_id:3});
    assert.equal(result.status,200);
    summary = (await call(2, '/resumen')).body;
    assert.equal(summary.resumen.en_atencion, 1); assert.equal(summary.en_atencion[0].id, 1);
    assert.equal(summary.en_atencion[0].responsable_nombre, 'Gestor B');
    result = await call(3,'/1/atencion','PUT',{...update,version:2,estado_atencion:'resuelto',responsable_id:3,nota:'Servicio restablecido'});
    assert.equal(result.status,200);
    assert.equal((await call(2,'?estado_atencion=resuelto&responsable_id=3')).body.resumen.total,1);
    assert.equal((await call(2,'?responsable_id=sin_asignar')).body.resumen.total,1);
    result = await call(2,'/1/atencion','PUT',{...update,version:3,nota:'Se reabre por nueva evidencia'});
    assert.equal(result.status,200);
    assert.equal((await call(2,'/2/atencion','PUT',{...update,estado_atencion:'descartado',nota:'Reporte duplicado'})).status,200);
    summary = (await call(2, '/resumen')).body;
    assert.equal(summary.resumen.pendientes, 1); assert.equal(summary.resumen.sin_responsable, 0);
    assert.equal(summary.resumen.descartados, 1);
    assert.equal((await call(2,'?pendientes=true&responsable_id=sin_asignar')).body.resumen.total,0);
    assert.equal((await call(2,'?pendientes=true')).body.resumen.total,1);
    const before = (await call(2,'/1')).body;
    failHistory = true;
    assert.equal((await call(2,'/1/atencion','PUT',{...update,version:4,nota:'No debe persistir'})).status,503);
    failHistory = false;
    const after = (await call(2,'/1')).body;
    assert.deepEqual(after,before);
    await db.exec("DELETE FROM gestion_roles WHERE usuario_id=3");
    assert.equal((await call(3)).status,403);
    assert.equal((await call(2,'/1/atencion','PUT',{...update,version:4,responsable_id:3})).status,400);
  } finally { if (server) await new Promise(resolve => server.close(resolve)); await db.close(); }
});
