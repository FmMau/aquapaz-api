const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const {schemaSql}=require('../scripts/database-tools');
const {createMarketplace}=require('../src/services/pipa-marketplace');
const {tariff,createRouting,distance}=require('../src/services/pipa-routing');

test('tariff uses integer cents and only explicitly configured production rates',()=>{
  assert.equal(tariff(3500,2000,{}).precio_centavos,48000);
  assert.equal(tariff(3500,2000,{}).prueba,true);
  assert.throws(()=>tariff(3500,2000,{PIPA_TARIFA_MODO:'real'}),e=>e.status===503);
  assert.equal(tariff(1,1,{}).traslado_centavos,2);
  assert.equal(tariff(1,1000,{PIPA_TARIFA_MODO:'real',PIPA_BASE_CENTAVOS:'100',PIPA_LITRO_CENTAVOS:'2',PIPA_KM_CENTAVOS:'10'}).prueba,false);
  assert.throws(()=>tariff(100000,1000000000,{}),e=>e.status===400);
});
test('routing requests street geometry and traffic; failure is labeled approximation without fake geometry',async()=>{
  let request;
  const origin={latitud:24.12,longitud:-110.32},end={latitud:24.13,longitud:-110.33};
  const google=createRouting({env:{GOOGLE_ROUTES_API_KEY:'test-only'},fetcher:async(url,options)=>{request={url,...options};return {ok:true,json:async()=>({routes:[{distanceMeters:1800,duration:'240s',polyline:{encodedPolyline:'abc'}}]})};}});
  const result=await google(origin,end);
  assert.equal(result.minutos,4);assert.equal(result.fuente,'google');assert.equal(result.polyline,'abc');
  assert.equal(JSON.parse(request.body).routingPreference,'TRAFFIC_AWARE');assert.ok(request.headers['X-Goog-FieldMask'].includes('polyline'));
  const approximate=await createRouting({env:{GOOGLE_ROUTES_API_KEY:'test-only'},fetcher:async()=>{throw new Error('offline');}})(origin,end);
  assert.equal(approximate.fuente,'aproximada');assert.equal(approximate.polyline,null);assert.equal(approximate.trafico,false);
  assert.equal(distance(origin,origin),0);
});
test('marketplace persists fixed pre-assignment quotes, expires offers, reassigns, protects GPS and preserves legacy data',async()=>{
  const db=new PGlite();
  const client={query:(sql,args)=>db.query(sql,args),release(){}};
  const pool={query:client.query,connect:async()=>client};
  try{
    await db.exec(schemaSql());
    await db.exec(schemaSql()); // startup migrations remain repeatable
    await db.exec("INSERT INTO usuarios(id,nombre,email) VALUES(1,'Cliente','client@test.test'),(2,'Pipa A','a@test.test'),(3,'Pipa B','b@test.test'),(4,'Otro','other@test.test')");
    await db.exec("INSERT INTO operadores_pipa(id,usuario_id,nombre,placas,telefono,capacidad,disponible,posicion_latitud,posicion_longitud,posicion_en) VALUES(1,2,'A','AAA','6121234567',7500,true,24.12,-110.32,NOW()),(2,3,'B','BBB','6121234567',10000,true,24.14,-110.34,NOW())");
    let routes=0;
    const market=createMarketplace({pool,env:{},route:async()=>{routes++;return {fuente:'google',distancia_metros:2000,minutos:5,polyline:'abc',trafico:true};}});
    const point={litros:3500,latitud:24.125,longitud:-110.325};
    const quote=await market.quote(1,point);
    assert.equal(quote.precio_centavos,48000);assert.equal(quote.prueba,true);assert.equal(quote.polyline,undefined);assert.equal(quote.operador_referencia,undefined);
    const payload={...point,client_id:'order-test-123',colonia:'Centro',direccion:'Morelos 123',referencias:'',telefono:'6121234567',cotizacion_id:quote.id,aceptar_cotizacion:true,precio_centavos:1};
    await assert.rejects(market.create(4,payload),e=>e.status===409);
    await assert.rejects(market.create(1,{...payload,litros:3501}),e=>e.status===409);
    const order=await market.create(1,payload);
    assert.equal(order.precio_centavos,48000);assert.ok(order.precio_aceptado_en);assert.equal(order.operador_id,null);
    // Lost create responses are recoverable after the quote expires.
    await db.query("UPDATE pipa_cotizaciones SET vence_en=NOW()-INTERVAL '1 second' WHERE id=$1",[quote.id]);
    assert.equal((await market.create(1,payload)).id,order.id);
    assert.equal((await db.query("SELECT * FROM notificaciones WHERE evento='solicitada'")).rows.length,0);
    await market.tick();
    const offers=await market.offers(2);assert.equal(offers.length,1);assert.equal((await market.offers(3)).length,0);
    for(const field of ['latitud','longitud','telefono','direccion','posicion_latitud'])assert.equal(offers[0][field],undefined);
    await assert.rejects(market.accept(3,order.id,offers[0].oferta_id),e=>e.status===409);
    await db.query("UPDATE pipa_ofertas SET vence_en=NOW()-INTERVAL '1 second' WHERE id=$1",[offers[0].oferta_id]);
    await market.tick();
    assert.equal((await market.offers(2)).length,0);
    const second=(await market.offers(3))[0];assert.ok(second);
    await assert.rejects(market.accept(2,order.id,offers[0].oferta_id),e=>e.status===409);
    const accepted=await market.accept(3,order.id,second.oferta_id);
    assert.equal(accepted.estado,'asignada');assert.equal(accepted.precio_centavos,48000);assert.equal(accepted.operador_id,2);
    assert.equal((await market.accept(3,order.id,second.oferta_id)).id,order.id);
    assert.equal((await market.itinerary(1,order.id)).ruta,null);
    await assert.rejects(market.itinerary(4,order.id),e=>e.status===404);
    await db.query("UPDATE pedidos_pipa SET estado='en_camino',pipa_latitud=24.14,pipa_longitud=-110.34,pipa_observada_en=NOW() WHERE id=$1",[order.id]);
    assert.equal((await market.itinerary(1,order.id)).ruta.fuente,'google');
    assert.equal((await market.itinerary(1,order.id)).ruta.fuente,'google');assert.equal(routes,2);
    await db.query("UPDATE pedidos_pipa SET pipa_observada_en=NOW()-INTERVAL '1 minute' WHERE id=$1",[order.id]);
    assert.equal((await market.itinerary(1,order.id)).ruta,null);
    await db.query("UPDATE pedidos_pipa SET estado='completada' WHERE id=$1",[order.id]);
    await db.query("UPDATE operadores_pipa SET posicion_en=NOW()-INTERVAL '3 minutes'");
    await assert.rejects(market.quote(1,point),e=>e.status===409);
    await assert.rejects(market.position(2,{latitud:24.12,longitud:-110.32,observada_en:Date.now(),precision:900}),e=>e.status===400);
  }finally{await db.close();}
});

test('HTTP market endpoints require authentication and a stored quote; modern acceptance cannot fall through to legacy',async()=>{
  const express=require('express');
  const {createRouter}=require('../src/routes/pipa-market.routes');
  const db=new PGlite();let server;
  const query=async(sql,args)=>{
    if(!args&&sql.includes(';')){await db.exec(sql);return {rows:[]};}
    return db.query(sql,args);
  };
  const client={query,release(){}};
  const pool={query,connect:async()=>client};
  try{
    await db.exec(schemaSql());
    await db.exec("INSERT INTO usuarios(id,nombre) VALUES(1,'Cliente'),(2,'Conductor')");
    await db.exec("INSERT INTO operadores_pipa(id,usuario_id,nombre,placas,telefono,capacidad,disponible,posicion_latitud,posicion_longitud,posicion_en) VALUES(1,2,'Pipa','AAA','6121234567',7500,true,24.12,-110.32,NOW())");
    const market=createMarketplace({pool,env:{},route:async()=>({fuente:'aproximada',distancia_metros:2000,minutos:5,polyline:null,trafico:false})});
    const app=express();app.use(express.json());
    app.use('/api/pipas',createRouter({pool,market,auth:(req,res,next)=>{if(!req.get('x-test-user'))return res.status(401).json({error:'auth'});req.user={id:Number(req.get('x-test-user'))};next();}}));
    app.post('/api/pipas/pedidos/:id/aceptar',(req,res)=>res.json({legacy:true}));
    server=await new Promise(resolve=>{const listening=app.listen(0,'127.0.0.1',()=>resolve(listening));});
    const url=`http://127.0.0.1:${server.address().port}/api/pipas`;
    const call=async(path,user,body,method='POST')=>{
      const response=await fetch(url+path,{method,headers:{'Content-Type':'application/json',...(user?{'x-test-user':String(user)}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
      return {status:response.status,body:await response.json()};
    };
    const point={litros:3500,latitud:24.125,longitud:-110.325};
    assert.equal((await call('/cotizar',null,point)).status,401);
    assert.equal((await call('/pedidos',1,{...point,client_id:'no-quote-123'})).status,400);
    const quote=await call('/cotizar',1,point);assert.equal(quote.status,200);
    const order=await call('/pedidos',1,{...point,client_id:'http-market-123',colonia:'Centro',direccion:'Morelos 123',telefono:'6121234567',referencias:'',cotizacion_id:quote.body.id,aceptar_cotizacion:true});
    assert.equal(order.status,200);assert.equal(order.body.precio_centavos,48000);
    const pending=await call('/ofertas',2,undefined,'GET');assert.equal(pending.body.length,1);
    const bad=await call(`/pedidos/${order.body.id}/aceptar`,2,{});assert.equal(bad.status,400);assert.equal(bad.body.legacy,undefined);
    const accepted=await call(`/pedidos/${order.body.id}/aceptar`,2,{oferta_id:pending.body[0].oferta_id});
    assert.equal(accepted.status,200);assert.equal(accepted.body.estado,'asignada');
    const route=await call(`/pedidos/${order.body.id}/ruta`,1,undefined,'GET');assert.equal(route.status,200);assert.equal(route.body.ruta,null);
  }finally{if(server)await new Promise(resolve=>server.close(resolve));await db.close();}
});
