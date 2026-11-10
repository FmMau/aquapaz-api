const error = (status, message) => Object.assign(new Error(message), { status });
const validPoint = p => p && typeof p.latitud === 'number' && Number.isFinite(p.latitud) && Math.abs(p.latitud) <= 90 && typeof p.longitud === 'number' && Number.isFinite(p.longitud) && Math.abs(p.longitud) <= 180;
function distance(a, b) {
  const r = x => x * Math.PI / 180;
  const h = Math.sin(r(b.latitud-a.latitud)/2)**2 + Math.cos(r(a.latitud))*Math.cos(r(b.latitud))*Math.sin(r(b.longitud-a.longitud)/2)**2;
  return Math.round(6371000 * 2 * Math.asin(Math.sqrt(Math.min(1,h))));
}
function tariff(litros, metros, env = process.env) {
  const demo = env.PIPA_TARIFA_MODO !== 'real';
  const read = (key, fallback) => {
    const raw = env[key] ?? (demo ? String(fallback) : '');
    if (!/^\d{1,8}$/.test(raw)) throw error(503, 'Falta configurar la tarifa de pipas.');
    return Number(raw);
  };
  const base = read('PIPA_BASE_CENTAVOS',10000), litro = read('PIPA_LITRO_CENTAVOS',10), km = read('PIPA_KM_CENTAVOS',1500);
  const agua = litros * litro, traslado = Math.ceil(metros * km / 1000), total = base + agua + traslado;
  if (!Number.isSafeInteger(total) || total < 1 || total > 10000000) throw error(400,'El importe excede el límite de la cotización.');
  return { base_centavos:base, litro_centavos:litro, km_centavos:km, agua_centavos:agua, traslado_centavos:traslado, precio_centavos:total, prueba:demo };
}
function createRouting({ env = process.env, fetcher = fetch } = {}) {
  return async (origin, destination) => {
    if (!validPoint(origin) || !validPoint(destination)) throw error(400,'Coordenadas inválidas.');
    if (env.GOOGLE_ROUTES_API_KEY) {
      try {
        const waypoint = p => ({ location: { latLng: { latitude:p.latitud, longitude:p.longitud } } });
        const response = await fetcher('https://routes.googleapis.com/directions/v2:computeRoutes', {
          method:'POST', signal:AbortSignal.timeout(8000),
          headers:{'Content-Type':'application/json','X-Goog-Api-Key':env.GOOGLE_ROUTES_API_KEY,'X-Goog-FieldMask':'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline'},
          body:JSON.stringify({ origin:waypoint(origin),destination:waypoint(destination),travelMode:'DRIVE',routingPreference:'TRAFFIC_AWARE',languageCode:'es-MX',units:'METRIC' }),
        });
        if (!response.ok) throw new Error('Routing unavailable');
        const route = (await response.json()).routes?.[0];
        const seconds = /^\d+(\.\d+)?s$/.test(route?.duration) ? Number(route.duration.slice(0,-1)) : NaN;
        if (!Number.isInteger(route?.distanceMeters) || route.distanceMeters < 0 || !Number.isFinite(seconds) || seconds < 0 || typeof route.polyline?.encodedPolyline !== 'string' || route.polyline.encodedPolyline.length > 100000) throw new Error('Invalid route');
        return { fuente:'google',distancia_metros:route.distanceMeters,minutos:Math.max(1,Math.ceil(seconds/60)),polyline:route.polyline.encodedPolyline,trafico:true };
      } catch { /* Clearly labeled approximation when routing fails or is unconfigured. */ }
    }
    const meters = Math.ceil(distance(origin,destination)*1.3);
    return { fuente:'aproximada',distancia_metros:meters,minutos:Math.max(1,Math.ceil(meters/25000*60)),polyline:null,trafico:false };
  };
}
module.exports = { error, validPoint, distance, tariff, createRouting };
