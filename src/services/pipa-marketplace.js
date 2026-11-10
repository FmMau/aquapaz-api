const { error, validPoint, distance, tariff, createRouting } = require('./pipa-routing');
const active = "estado NOT IN ('completada','cancelada')";
const geo = `ROUND((6371000*2*ASIN(SQRT(LEAST(1.0,
  POWER(SIN(RADIANS(o.posicion_latitud-$1::double precision)/2),2)+COS(RADIANS($1::double precision))*COS(RADIANS(o.posicion_latitud))*POWER(SIN(RADIANS(o.posicion_longitud-$2::double precision)/2),2)))))::numeric)::int`;
const publicQuote = row => ({ id:row.id, litros:row.litros, latitud:row.latitud, longitud:row.longitud, vence_en:row.vence_en, hora_servidor:new Date().toISOString(), ...row.detalle });
function createMarketplace({ pool, route = createRouting(), env = process.env }) {
  async function candidates(db, point, litros, owner, orderId = null) {
    return (await db.query(`SELECT o.id,o.usuario_id,${geo} AS distancia_metros
      FROM operadores_pipa o WHERE o.disponible AND o.capacidad >= $3 AND o.usuario_id <> $4
      AND o.posicion_en > NOW()-INTERVAL '120 seconds' AND o.posicion_latitud IS NOT NULL AND o.posicion_longitud IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM pedidos_pipa p WHERE p.operador_id=o.id AND p.${active})
      AND NOT EXISTS (SELECT 1 FROM pipa_ofertas f WHERE f.operador_id=o.id AND f.pedido_id=$5)
      AND NOT EXISTS (SELECT 1 FROM pipa_ofertas f WHERE f.operador_id=o.id AND f.estado='pendiente' AND f.vence_en>NOW())
      AND ${geo} <= 30000 ORDER BY distancia_metros,o.id LIMIT 30`, [point.latitud,point.longitud,litros,owner,orderId])).rows;
  }
  async function transaction(action) {
    const db = await pool.connect();
    try { await db.query('BEGIN'); await db.query("SET LOCAL lock_timeout='5s'"); await db.query("SET LOCAL statement_timeout='15s'"); const result = await action(db); await db.query('COMMIT'); return result; }
    catch (failure) { await db.query('ROLLBACK').catch(()=>{}); throw failure; }
    finally { db.release(); }
  }
  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      await transaction(async db => {
        await db.query(`UPDATE pipa_ofertas f SET estado=CASE WHEN p.estado='solicitada' THEN 'vencida' ELSE 'cancelada' END
          FROM pedidos_pipa p WHERE p.id=f.pedido_id AND f.estado='pendiente' AND (f.vence_en<=NOW() OR p.estado<>'solicitada')`);
        await db.query(`UPDATE pedidos_pipa SET estado='cancelada',actualizado=NOW() WHERE mercado_cotizacion_id IS NOT NULL
          AND estado='solicitada' AND busqueda_vence_en<=NOW()`);
        const orders = (await db.query(`SELECT p.* FROM pedidos_pipa p WHERE p.mercado_cotizacion_id IS NOT NULL
          AND p.estado='solicitada' AND p.busqueda_vence_en>NOW()
          AND NOT EXISTS (SELECT 1 FROM pipa_ofertas f WHERE f.pedido_id=p.id AND f.estado='pendiente')
          ORDER BY p.fecha LIMIT 20 FOR UPDATE OF p SKIP LOCKED`)).rows;
        for (const order of orders) {
          const candidate = (await candidates(db,order,order.litros,order.usuario_id,order.id))[0];
          if (!candidate) continue;
          const offer = (await db.query(`INSERT INTO pipa_ofertas(pedido_id,operador_id,distancia_metros,vence_en)
            VALUES($1,$2,$3,LEAST(NOW()+INTERVAL '60 seconds',$4::timestamptz)) ON CONFLICT DO NOTHING RETURNING id`,
          [order.id,candidate.id,candidate.distancia_metros,order.busqueda_vence_en])).rows[0];
          if (!offer) continue;
          await db.query(`INSERT INTO notificaciones(usuario_id,pedido_id,evento,destinatario,titulo,mensaje,tipo,push_estado,push_intentos,push_proximo)
            VALUES($1,$2,$3,'operador','Oferta de entrega cercana','Tienes hasta 60 segundos para aceptar una entrega. Revisa litros e importe en AquaPaz.','pipa','pendiente',0,NOW()) ON CONFLICT DO NOTHING`,
          [candidate.usuario_id,order.id,`oferta:${offer.id}`]);
        }
      });
    } finally { ticking = false; }
  }
  return {
    tick, candidates,
    async quote(userId, body) {
      if (!Number.isSafeInteger(body?.litros) || body.litros<1 || body.litros>100000 || !validPoint(body)) throw error(400,'Indica de 1 a 100,000 litros enteros y un punto válido.');
      const nearest = (await candidates(pool,body,body.litros,userId))[0];
      if (!nearest) throw error(409,'No hay pipas cercanas con capacidad y GPS reciente. Intenta más tarde.');
      const operator = (await pool.query('SELECT posicion_latitud AS latitud,posicion_longitud AS longitud FROM operadores_pipa WHERE id=$1',[nearest.id])).rows[0];
      const journey = await route(operator,body);
      if (journey.minutos > 1440) throw error(400,'El punto está fuera de la cobertura de entrega.');
      const detail = { ...tariff(body.litros,journey.distancia_metros,env), distancia_metros:journey.distancia_metros,
        llegada_estimada_minutos:journey.minutos, fuente:journey.fuente, trafico:journey.trafico };
      const row = (await pool.query(`INSERT INTO pipa_cotizaciones(usuario_id,operador_referencia,litros,latitud,longitud,detalle,vence_en)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,NOW()+INTERVAL '5 minutes') RETURNING *`,
      [userId,nearest.id,body.litros,body.latitud,body.longitud,JSON.stringify(detail)])).rows[0];
      return publicQuote(row);
    },
    async create(userId, body) {
      const text = (x,min,max) => typeof x==='string' && x.trim().length>=min && x.trim().length<=max;
      if (!text(body?.client_id,8,128) || !/^[A-Za-z0-9_-]+$/.test(body.client_id) || !text(body.colonia,2,100)
        || !text(body.direccion,5,300) || !text(body.referencias??'',0,500) || !text(body.telefono,10,20)
        || !/^[+\d ()-]+$/.test(body.telefono) || body.telefono.replace(/\D/g,'').length<10
        || !Number.isSafeInteger(body.cotizacion_id) || body.cotizacion_id<1 || body.aceptar_cotizacion!==true || !validPoint(body)
        || !Number.isSafeInteger(body.litros) || body.litros<1 || body.litros>100000) throw error(400,'Revisa los datos y acepta una cotización vigente antes de solicitar.');
      return transaction(async db => {
        // Serialize same-owner retries and preserve one active delivery.
        await db.query('SELECT id FROM usuarios WHERE id=$1 FOR UPDATE',[userId]);
        const existing = (await db.query('SELECT * FROM pedidos_pipa WHERE usuario_id=$1 AND client_id=$2',[userId,body.client_id])).rows[0];
        const matches = order => ['colonia','direccion','referencias','telefono','litros','latitud','longitud'].every(key=>order[key]===(typeof body[key]==='string'?body[key].trim():body[key]??'')) && order.mercado_cotizacion_id===body.cotizacion_id;
        if (existing) { if (!matches(existing)) throw error(409,'Este identificador ya se usó con otros datos.'); return existing; }
        const quote = (await db.query(`SELECT * FROM pipa_cotizaciones WHERE id=$1 AND usuario_id=$2 AND vence_en>NOW() FOR UPDATE`,[body.cotizacion_id,userId])).rows[0];
        if (!quote || quote.litros!==body.litros || quote.latitud!==body.latitud || quote.longitud!==body.longitud) throw error(409,'La cotización venció o cambió el punto o la cantidad. Vuelve a cotizar.');
        return (await db.query(`INSERT INTO pedidos_pipa(usuario_id,client_id,colonia,direccion,referencias,telefono,litros,latitud,longitud,
          mercado_cotizacion_id,tarifa_detalle,precio_centavos,cotizacion_version,precio_aceptado_en,llegada_estimada_minutos,cotizacion_notas,busqueda_vence_en)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,1,NOW(),$13,$14,NOW()+INTERVAL '30 minutes') RETURNING *`,
        [userId,body.client_id,body.colonia.trim(),body.direccion.trim(),(body.referencias||'').trim(),body.telefono.trim(),body.litros,body.latitud,body.longitud,
          quote.id,JSON.stringify(quote.detalle),quote.detalle.precio_centavos,quote.detalle.llegada_estimada_minutos,
          `${quote.detalle.prueba?'Tarifa de prueba. ':''}Incluye litros y traslado. Pago directo al conductor. Importe confirmado antes de asignar.`])).rows[0];
      });
    },
    async offers(userId) {
      return (await pool.query(`SELECT p.id,p.colonia,p.litros,p.fecha,p.estado,p.precio_centavos,p.tarifa_detalle,
        f.id AS oferta_id,f.vence_en AS oferta_vence_en,f.distancia_metros,NOW() AS hora_servidor
        FROM pipa_ofertas f JOIN pedidos_pipa p ON p.id=f.pedido_id JOIN operadores_pipa o ON o.id=f.operador_id
        WHERE o.usuario_id=$1 AND o.disponible AND o.capacidad>=p.litros AND o.posicion_en>NOW()-INTERVAL '120 seconds'
          AND f.estado='pendiente' AND f.vence_en>NOW() AND p.estado='solicitada' AND p.busqueda_vence_en>NOW()
          AND NOT EXISTS (SELECT 1 FROM pedidos_pipa job WHERE job.operador_id=o.id AND job.${active})
        ORDER BY f.vence_en LIMIT 30`,[userId])).rows;
    },
    async accept(userId, orderId, offerId) {
      if (!Number.isSafeInteger(offerId) || offerId<1) throw error(400,'Selecciona una oferta vigente.');
      return transaction(async db => {
        // Operator-first lock order matches legacy acceptance and management.
        const operator = (await db.query('SELECT * FROM operadores_pipa WHERE usuario_id=$1 FOR UPDATE',[userId])).rows[0];
        if (!operator?.disponible || !operator.posicion_en || Date.now()-new Date(operator.posicion_en).getTime()>120000) throw error(409,'Activa disponibilidad y actualiza el GPS.');
        const order = (await db.query('SELECT * FROM pedidos_pipa WHERE id=$1 FOR UPDATE',[orderId])).rows[0];
        if (order?.operador_id===operator.id && order.estado==='asignada') return order;
        const offer = (await db.query(`SELECT * FROM pipa_ofertas WHERE id=$1 AND pedido_id=$2 AND operador_id=$3 AND estado='pendiente' AND vence_en>clock_timestamp() FOR UPDATE`,[offerId,orderId,operator.id])).rows[0];
        if (!offer || !order || order.estado!=='solicitada' || order.usuario_id===userId || order.litros>operator.capacidad) throw error(409,'La oferta venció o ya no está disponible.');
        if ((await db.query(`SELECT id FROM pedidos_pipa WHERE operador_id=$1 AND ${active}`,[operator.id])).rows.length) throw error(409,'Ya tienes una entrega activa.');
        const result = (await db.query(`UPDATE pedidos_pipa SET operador_id=$1,estado='asignada',actualizado=NOW()
          WHERE id=$2 AND estado='solicitada' AND busqueda_vence_en>NOW() RETURNING *`,[operator.id,orderId])).rows[0];
        if (!result) throw error(409,'La búsqueda terminó.');
        await db.query("UPDATE pipa_ofertas SET estado='aceptada' WHERE id=$1",[offerId]);
        return result;
      });
    },
    async decline(userId, orderId, offerId) {
      const result = await pool.query(`UPDATE pipa_ofertas SET estado='rechazada' WHERE id=$1 AND pedido_id=$2
        AND operador_id IN (SELECT id FROM operadores_pipa WHERE usuario_id=$3) AND estado='pendiente' AND vence_en>NOW() RETURNING id`,[offerId,orderId,userId]);
      if (!result.rows.length) throw error(409,'La oferta ya no está vigente.');
      return { ok:true };
    },
    async position(userId, body) {
      if (!validPoint(body) || !Number.isSafeInteger(body.observada_en) || Math.abs(Date.now()-body.observada_en)>30000
        || typeof body.precision!=='number' || !Number.isFinite(body.precision) || body.precision<0 || body.precision>500) throw error(400,'Se necesita GPS reciente con precisión de hasta 500 metros.');
      const result = await pool.query(`UPDATE operadores_pipa SET posicion_latitud=$1,posicion_longitud=$2,posicion_en=$3
        WHERE usuario_id=$4 AND disponible AND (posicion_en IS NULL OR posicion_en<$3::timestamptz) RETURNING id`,
      [body.latitud,body.longitud,new Date(body.observada_en).toISOString(),userId]);
      return { aceptada:!!result.rows.length };
    },
    async itinerary(userId, orderId) {
      const order = (await pool.query(`SELECT * FROM pedidos_pipa WHERE id=$1 AND (usuario_id=$2 OR operador_id IN (SELECT id FROM operadores_pipa WHERE usuario_id=$2))`,[orderId,userId])).rows[0];
      if (!order) throw error(404,'Pedido no disponible.');
      const now = Date.now();
      if (!['en_camino','en_sitio'].includes(order.estado) || order.pipa_latitud==null || order.pipa_longitud==null
        || now-new Date(order.pipa_observada_en).getTime()>45000 || !order.pipa_observada_en) return { ruta:null, hora_servidor:new Date().toISOString() };
      if (order.ruta_actual && now-new Date(order.ruta_calculada_en).getTime()<30000) return { ruta:order.ruta_actual,calculada_en:order.ruta_calculada_en,hora_servidor:new Date().toISOString() };
      const journey = await route({latitud:order.pipa_latitud,longitud:order.pipa_longitud},order);
      const calculated = new Date().toISOString();
      // Do not store a result across delivery completion or a different assignment.
      const saved = await pool.query(`UPDATE pedidos_pipa SET ruta_actual=$1::jsonb,ruta_calculada_en=$2
        WHERE id=$3 AND operador_id=$4 AND estado IN ('en_camino','en_sitio')
          AND pipa_observada_en>=$5::timestamptz AND pipa_latitud IS NOT NULL RETURNING id`,[JSON.stringify(journey),calculated,order.id,order.operador_id,order.pipa_observada_en]);
      return { ruta:saved.rows.length?journey:null,calculada_en:calculated,hora_servidor:new Date().toISOString() };
    },
  };
}
module.exports = { createMarketplace };
