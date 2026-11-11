const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const express=require('express');
const {PGlite}=require('@electric-sql/pglite');
const {schemaSql}=require('../scripts/database-tools');
const {createWebPushWorker}=require('../src/services/web-push');

test('a report notifies only other neighbors, queues push on every device and supports real idempotent confirmation',async()=>{
  const db=new PGlite();let server;
  const pool={query:(sql,args)=>db.query(sql,args),connect:async()=>({query:(sql,args)=>db.query(sql,args),release(){}})};
  const auth=async(req,res,next)=>{
    const id=Number(req.headers.authorization);
    const result=await db.query('SELECT id,colonia FROM usuarios WHERE id=$1',[id||-1]);
    if(!result.rows.length)return res.status(401).json({error:'login'});
    req.user=result.rows[0];next();
  };
  function route(file){
    const context={module:{exports:{}},Buffer,console,process,fetch:()=>assert.fail('No native push tokens in this test'),require:name=>{
      if(name==='express')return express;
      if(name==='../database/db')return pool;
      if(name==='../middlewares/auth.middleware')return auth;
      throw new Error(name);
    }};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/routes',file),'utf8'),context);
    return context.module.exports;
  }
  try{
    await db.exec(schemaSql());await db.exec(schemaSql());
    await db.exec(`INSERT INTO usuarios(id,nombre,colonia) VALUES(1,'Autor','Centro'),(2,'Vecino','Centro'),(3,'Otra colonia','Camino Real'),(4,'Sin push','Centro');
      INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth) VALUES
      (1,'https://fcm.googleapis.com/author','key','auth'),
      (2,'https://fcm.googleapis.com/neighbor-a','key','auth'),
      (2,'https://fcm.googleapis.com/neighbor-b','key','auth'),
      (3,'https://fcm.googleapis.com/other','key','auth');`);
    const app=express();app.use(express.json());app.use('/reportes',route('reportes.routes.js'));app.use('/notificaciones',route('notificaciones.routes.js'));
    server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    async function call(user,url,method='GET',body){const res=await fetch(base+url,{method,headers:{Authorization:String(user),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return{status:res.status,data:await res.json()};}
    const body={colonia:'Centro',tipo:'agua',estado:'no_agua',comentario:'Sin servicio',client_id:'report-push-test-001'};
    const created=await call(1,'/reportes','POST',body);assert.equal(created.status,201);
    const id=created.data.id;
    const inbox=await call(2,'/notificaciones');assert.equal(inbox.status,200);assert.equal(inbox.data.length,1);assert.equal(inbox.data[0].reporte_id,id);assert.equal(inbox.data[0].puede_confirmar,true);
    assert.equal((await call(1,'/notificaciones')).data.length,0);assert.equal((await call(3,'/notificaciones')).data.length,0);
    assert.equal((await call(4,'/notificaciones')).data.length,1);
    assert.equal((await db.query('SELECT * FROM web_push_deliveries')).rows.length,2);
    const replay=await call(1,'/reportes','POST',body);assert.equal(replay.data.replayed,true);assert.equal((await db.query('SELECT * FROM notificaciones')).rows.length,2);
    const pushes=[];
    const worker=createWebPushWorker({pool,env:{VAPID_PUBLIC_KEY:'public',VAPID_PRIVATE_KEY:'private',VAPID_SUBJECT:'mailto:test@example.test'},sender:{setVapidDetails(){},async sendNotification(sub,payload,options){pushes.push({endpoint:sub.endpoint,data:JSON.parse(payload),options});}},logger:{warn(){},error(error){assert.fail(error);}}});
    await worker.tick();assert.equal(pushes.length,2);assert.ok(pushes.every(push=>push.endpoint.includes('neighbor')&&push.data.url===`#/notificaciones?reporte=${id}`));
    await worker.tick();assert.equal(pushes.length,2);
    assert.equal((await call(1,`/reportes/${id}/confirmar`,'POST',{decision:'confirmar'})).status,403);
    assert.equal((await call(3,`/reportes/${id}/confirmar`,'POST',{decision:'confirmar'})).status,404);
    const confirmed=await call(2,`/reportes/${id}/confirmar`,'POST',{decision:'confirmar'});assert.equal(confirmed.status,200);assert.equal(confirmed.data.confirmaciones,1);
    const repeat=await call(2,`/reportes/${id}/confirmar`,'POST',{decision:'confirmar'});assert.equal(repeat.data.confirmaciones,1);
    const after=(await call(2,'/notificaciones')).data[0];assert.equal(after.mi_decision,'confirmar');assert.equal(after.puede_confirmar,false);assert.equal(after.leido,true);assert.equal(after.confirmada,true);
    assert.equal((await call(2,`/reportes/${id}/confirmar`,'POST',{decision:'rechazar'})).status,409);
    assert.equal((await call(4,`/reportes/${id}/confirmar`,'POST',{decision:'rechazar'})).status,200);
    assert.equal((await call(4,'/notificaciones')).data[0].mi_decision,'rechazar');
    await db.exec("UPDATE usuarios SET colonia='Otra' WHERE id=2");assert.equal((await call(2,'/notificaciones')).data[0].puede_confirmar,false);
    await db.exec("SET aquapaz.restoring='on'; INSERT INTO reportes(colonia,tipo,estado,comentario,usuario_id,client_id) VALUES('Centro','agua','baja_presion','Restore',1,'restored-report'); SET aquapaz.restoring='off';");
    assert.equal((await db.query('SELECT * FROM notificaciones')).rows.length,2);
  }finally{if(server)await new Promise(resolve=>server.close(resolve));await db.close();}
});
