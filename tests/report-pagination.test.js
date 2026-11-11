const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const { schemaSql } = require('../scripts/database-tools');

test('report pages preserve microsecond ties, cover null dates and never cross colony boundaries', async () => {
  const db = new PGlite(); let server;
  try {
    await db.exec(schemaSql()); await db.exec(schemaSql());
    await db.exec(`INSERT INTO usuarios(id,nombre,colonia) VALUES(1,'Vecino','Centro');
      INSERT INTO reportes(id,colonia,tipo,estado,fecha)
      SELECT i,'Centro','agua','no_agua',CASE WHEN i>120 THEN NULL
        ELSE TIMESTAMP '2026-11-01 10:00:00.123456'+((i%2)*INTERVAL '1 microsecond') END
      FROM generate_series(1,123) i;
      INSERT INTO reportes(id,colonia,tipo,estado) VALUES(999,'Otra','agua','no_agua');`);
    const pool = { query: (sql, args) => db.query(sql,args) };
    const context = { module:{exports:{}}, console, Buffer, process,
      fetch:()=>assert.fail('No external push'), require:name=>{
        if(name==='express')return express;
        if(name==='../database/db')return pool;
        if(name==='../middlewares/auth.middleware')return(req,res,next)=>{req.user={id:1,colonia:'Centro'};next();};
        throw new Error(name);
      }};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/routes/reportes.routes.js'),'utf8'),context);
    const app=express();app.use('/reportes',context.module.exports);
    server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    const base='http://127.0.0.1:'+server.address().port+'/reportes';
    const legacy=await(await fetch(base)).json();assert.equal(legacy.length,50);
    let cursor=null;const ids=[];
    do {
      const params=new URLSearchParams({limit:'17',...(cursor?{cursor}:{})});
      const response=await fetch(base+'?'+params);assert.equal(response.status,200);
      const page=await response.json();assert.ok(page.items.length<=17);
      assert.ok(page.items.every(row=>row.colonia==='Centro'&&!('cursor_fecha' in row)));
      ids.push(...page.items.map(row=>row.id));cursor=page.next_cursor;
      assert.equal(page.has_more,!!cursor);
    }while(cursor);
    assert.equal(ids.length,123);assert.equal(new Set(ids).size,123);assert.deepEqual(ids.slice(-3),[123,122,121]);
    const summary=await(await fetch(base+'/resumen')).json();assert.equal(summary.total,123);assert.equal(summary.no_agua,123);
    assert.equal((await fetch(base+'/999')).status,404);assert.equal((await fetch(base+'/1')).status,200);
    for(const query of ['limit=0','limit=101','limit=1.5','cursor=bad'])assert.equal((await fetch(base+'?'+query)).status,400);
  } finally {
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    await db.close();
  }
});
