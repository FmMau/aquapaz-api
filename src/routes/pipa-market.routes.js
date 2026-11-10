const { createMarketplace } = require('../services/pipa-marketplace');
const { limit } = require('../services/auth-security');
function createRouter({ pool, auth, market = createMarketplace({ pool }) }) {
  const router = require('express').Router();
  router.use(auth);
  const id = value => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));
  const handle = operation => async (req,res) => {
    res.set('Cache-Control','no-store');
    try { res.json(await operation(req)); }
    catch (failure) {
      res.status(failure.status || (failure.code==='23505'?409:503)).json({error:failure.status?failure.message:failure.code==='23505'?'Ya existe una entrega activa. Actualiza tus pedidos.':'No pudimos completar la operación de pipas. Vuelve a intentar.',...(failure.status&&failure.fields?{fields:failure.fields}:{})});
    }
  };
  router.post('/cotizar',handle(async req=>{
    await limit(pool,'pipa-cotizar',String(req.user.id),30,15);
    return market.quote(req.user.id,req.body);
  }));
  router.post('/pedidos',handle(async req=>{
    const order = await market.create(req.user.id,req.body);
    // A durable order survives a worker failure; the interval will retry dispatch.
    await market.tick().catch(()=>{});
    return order;
  }));
  router.put('/operador/posicion',handle(req=>market.position(req.user.id,req.body)));
  router.get('/ofertas',handle(req=>market.offers(req.user.id)));
  router.post('/pedidos/:id/rechazar-oferta',handle(async req=>{
    if (!id(req.params.id) || !Number.isSafeInteger(req.body?.oferta_id)) throw Object.assign(new Error('Oferta inválida.'),{status:400});
    const result = await market.decline(req.user.id,Number(req.params.id),req.body.oferta_id);
    await market.tick().catch(()=>{}); return result;
  }));
  router.post('/pedidos/:id/aceptar',async (req,res,next)=>{
    if (!id(req.params.id)) return res.status(400).json({error:'Pedido inválido.'});
    try {
      const row = (await pool.query('SELECT mercado_cotizacion_id FROM pedidos_pipa WHERE id=$1',[req.params.id])).rows[0];
      if (!row?.mercado_cotizacion_id) return next();
    } catch { return res.status(503).json({error:'No pudimos consultar el pedido.'}); }
    return handle(req=>market.accept(req.user.id,Number(req.params.id),req.body?.oferta_id))(req,res);
  });
  router.get('/pedidos/:id/ruta',handle(async req=>{
    if (!id(req.params.id)) throw Object.assign(new Error('Pedido inválido.'),{status:400});
    await limit(pool,'pipa-ruta',String(req.user.id),120,1);
    return market.itinerary(req.user.id,Number(req.params.id));
  }));
  router.get('/pedidos/:id',async(req,res,next)=>{
    if (!id(req.params.id)) return next();
    try {
      const row = (await pool.query(`SELECT mercado_cotizacion_id,usuario_id,operador_id FROM pedidos_pipa WHERE id=$1`,[req.params.id])).rows[0];
      if (!row?.mercado_cotizacion_id || row.usuario_id===req.user.id) return next();
      const mine = (await pool.query('SELECT id FROM operadores_pipa WHERE usuario_id=$1',[req.user.id])).rows[0];
      if (mine?.id===row.operador_id) return next();
      const offer = (await market.offers(req.user.id)).find(order=>order.id===Number(req.params.id));
      if (!offer) return res.status(404).json({error:'La oferta ya no está disponible.'});
      res.json({pedido:offer,disponible:true});
    } catch { res.status(503).json({error:'No pudimos consultar la oferta.'}); }
  });
  return router;
}
module.exports = { createRouter };
