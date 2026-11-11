const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createWebPushWorker } = require('../src/services/web-push');
const { createRouter } = require('../src/routes/push.routes');
const env = { VAPID_PUBLIC_KEY: 'public', VAPID_PRIVATE_KEY: 'private', VAPID_SUBJECT: 'mailto:test@example.com' };

test('a real pipa state change queues web push for every device of its recipient', async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const { schemaSql } = require('../scripts/database-tools');
  const db = new PGlite();
  try {
    await db.exec(schemaSql()); await db.exec(schemaSql());
    await db.exec(`INSERT INTO usuarios(id,nombre) VALUES(1,'Cliente'),(2,'Operador');
      INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth) VALUES
        (1,'https://fcm.googleapis.com/device-a','key','auth'),
        (1,'https://fcm.googleapis.com/device-b','key','auth'),
        (2,'https://fcm.googleapis.com/operator','key','auth');
      INSERT INTO operadores_pipa(id,usuario_id,nombre,placas,telefono,capacidad)
        VALUES(1,2,'Operador','AAA','6121234567',5000);
      INSERT INTO pedidos_pipa(usuario_id,operador_id,client_id,colonia,direccion,telefono,litros,latitud,longitud,estado)
        VALUES(1,1,'web-push-test','Centro','Calle 1','6121234567',5000,24.12,-110.32,'asignada');
      UPDATE pedidos_pipa SET estado='en_camino' WHERE id=1;`);
    const deliveries = (await db.query(`SELECT s.user_id,n.evento FROM web_push_deliveries d
      JOIN push_subscriptions s ON s.id=d.subscription_id JOIN notificaciones n ON n.id=d.notification_id`)).rows;
    assert.equal(deliveries.length,2);
    assert.ok(deliveries.every(row=>row.user_id===1 && row.evento==='en_camino'));
  } finally {await db.close();}
});

test('persistent subscriptions, ownership, event queue, expiry, retry and dead endpoints', async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const express = require('express');
  const db = new PGlite();
  let server;
  try {
    await db.exec(`CREATE TABLE usuarios(id SERIAL PRIMARY KEY);
      INSERT INTO usuarios VALUES(1),(2);
      CREATE TABLE notificaciones(id SERIAL PRIMARY KEY,usuario_id INTEGER,titulo TEXT,mensaje TEXT,evento TEXT,pedido_id INTEGER,reporte_id INTEGER);
      CREATE TABLE operadores_pipa(id INTEGER,usuario_id INTEGER);
      CREATE TABLE pedidos_pipa(id INTEGER,estado TEXT);
      CREATE TABLE pipa_ofertas(id INTEGER,pedido_id INTEGER,operador_id INTEGER,estado TEXT,vence_en TIMESTAMPTZ);`);
    const sql = fs.readFileSync(path.join(__dirname,'../migrations/011_web_push.sql'),'utf8');
    await db.exec(sql); await db.exec(sql);
    const app = express(); app.use(express.json());
    const auth = (req,res,next) => {
      if (!req.headers.authorization) return res.status(401).json({error:'login'});
      req.user = { id: Number(req.headers.authorization) }; next();
    };
    app.use('/api/push', createRouter({ pool: db, auth, env }));
    server = app.listen(0,'127.0.0.1'); await new Promise(resolve => server.once('listening',resolve));
    const origin = `http://127.0.0.1:${server.address().port}/api/push`;
    const key = Buffer.alloc(65); key[0]=4;
    const sub = { endpoint:'https://fcm.googleapis.com/fcm/send/test', keys:{p256dh:key.toString('base64url'),auth:Buffer.alloc(16).toString('base64url')} };
    const call = (route, body, user='1') => fetch(origin+route,{method:'POST',headers:{'Content-Type':'application/json',...(user?{Authorization:user}:{})},body:JSON.stringify(body)});
    assert.equal((await call('/subscribe',sub,'')).status,401);
    assert.equal((await call('/subscribe',{...sub,endpoint:'https://127.0.0.1/secret'})).status,400);
    assert.deepEqual(await (await fetch(origin+'/public-key')).json(),{publicKey:'public'});
    assert.equal((await call('/subscribe',sub)).status,201);
    await call('/subscribe',sub);
    assert.equal((await db.query('SELECT * FROM push_subscriptions')).rows.length,1);
    await db.exec("INSERT INTO notificaciones(usuario_id,titulo,mensaje,evento) VALUES(1,'Pipa','En camino','en_camino'),(2,'Otro','Privado','en_camino')");
    assert.equal((await db.query('SELECT * FROM web_push_deliveries')).rows.length,1);
    const sent = [];
    let failure;
    const sender = { setVapidDetails(){},async sendNotification(subscription,payload,options){
      if(failure) throw failure;
      sent.push({subscription,payload:JSON.parse(payload),options});
    } };
    const worker = createWebPushWorker({pool:db,env,sender,logger:{warn(){},error(error){assert.fail(error);}}});
    await worker.tick();
    assert.equal(sent.length,1); assert.equal(sent[0].payload.url,'#/notificaciones');
    assert.ok(sent[0].options.TTL<=3600);
    await worker.tick(); assert.equal(sent.length,1);
    await db.exec("INSERT INTO notificaciones(usuario_id,mensaje) VALUES(1,'Retry')");
    failure = {statusCode:429,headers:{'retry-after':'120'}}; await worker.tick();
    assert.equal((await db.query("SELECT state FROM web_push_deliveries ORDER BY id DESC LIMIT 1")).rows[0].state,'pending');
    await db.exec("UPDATE web_push_deliveries SET next_at=NOW()-INTERVAL '1 second' WHERE state='pending'");
    failure = {statusCode:410}; await worker.tick();
    assert.equal((await db.query('SELECT * FROM push_subscriptions')).rows.length,0);
    await call('/subscribe',sub);
    await db.exec("INSERT INTO notificaciones(usuario_id,mensaje,evento) VALUES(1,'Old','en_camino')");
    await db.exec("UPDATE web_push_deliveries SET expires_at=NOW()-INTERVAL '1 second'");
    failure = undefined; await worker.tick(); assert.equal(sent.length,1);
    await db.exec("INSERT INTO notificaciones(usuario_id,mensaje) VALUES(1,'Private')");
    await call('/subscribe',sub,'2');
    assert.equal((await db.query('SELECT * FROM web_push_deliveries')).rows.length,0);
    await call('/unsubscribe',{endpoint:sub.endpoint},'1');
    assert.equal((await db.query('SELECT * FROM push_subscriptions')).rows.length,1);
    await call('/unsubscribe',{endpoint:sub.endpoint},'2');
    assert.equal((await db.query('SELECT * FROM push_subscriptions')).rows.length,0);
  } finally { if(server) await new Promise(resolve=>server.close(resolve)); await db.close(); }
});
