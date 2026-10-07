const PUSH_URL = 'https://exp.host/--/api/v2/push/';
const validToken = token => typeof token === 'string' && /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/.test(token);
const retrySeconds = attempt => Math.min(3600, 30 * 2 ** Math.min(attempt, 7));

function createPushWorker({ pool, fetcher = fetch, accessToken = process.env.EXPO_ACCESS_TOKEN, logger = console }) {
  let running = false;
  async function expo(endpoint, body) {
    const response = await fetcher(PUSH_URL + endpoint, {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw Object.assign(new Error('Expo HTTP error'), { code: `HTTP_${response.status}`, retryable: response.status === 429 || response.status >= 500 });
    const result = await response.json();
    if (result.errors?.length) throw Object.assign(new Error('Expo API error'), { code: 'EXPO_API', retryable: false });
    return result.data;
  }
  async function finish(row, state, error = null, ticket = null, delay = 0) {
    await pool.query(`UPDATE notificaciones SET push_estado=$1,push_error=$2,push_ticket=$3,
      push_proximo=NOW()+($4 * INTERVAL '1 second') WHERE id=$5 AND push_estado=$6`,
    [state, error, ticket, delay, row.id, row.push_estado]);
  }
  async function invalidDevice(row) {
    await pool.query('UPDATE usuarios SET push_token=NULL WHERE id=$1 AND push_token=$2', [row.usuario_id, row.push_token_enviado]);
    await finish(row, 'fallida', 'DeviceNotRegistered');
  }
  async function ticketError(row, code) {
    if (code === 'DeviceNotRegistered') return invalidDevice(row);
    const retryable = code === 'MessageRateExceeded';
    await finish(row, retryable && row.push_intentos < 8 ? 'pendiente' : 'fallida', code || 'EXPO_ERROR', null, retrySeconds(row.push_intentos));
  }
  async function send(row) {
    if (!validToken(row.push_token_enviado)) return finish(row, 'sin_dispositivo');
    const ticket = await expo('send', {
      to: row.push_token_enviado, sound: 'default', title: row.titulo, body: row.mensaje, channelId: 'default', ttl: 3600,
      data: { tipo: 'pipa', usuario_id: row.usuario_id, notificacion_id: row.id, pedido_id: row.pedido_id, destinatario: row.destinatario },
    });
    if (ticket?.status === 'ok' && typeof ticket.id === 'string') return finish(row, 'recibo', null, ticket.id, 900);
    if (ticket?.status === 'error') return ticketError(row, ticket.details?.error);
    throw Object.assign(new Error('Invalid ticket'), { code: 'INVALID_TICKET', retryable: true });
  }
  async function receipt(row) {
    const receipts = await expo('getReceipts', { ids: [row.push_ticket] });
    const result = receipts?.[row.push_ticket];
    if (result?.status === 'ok') return finish(row, 'entregada');
    if (result?.status === 'error') return ticketError(row, result.details?.error);
    // Poll a missing receipt without resending the notification.
    await finish(row, row.push_intentos < 20 ? 'recibo' : 'fallida', 'RECEIPT_PENDING', row.push_ticket, 900);
  }
  async function tick() {
    if (running) return;
    running = true;
    try {
      // Atomic claim and lease also allow multiple API instances. Older events remain in the inbox only.
      const rows = (await pool.query(`WITH ready AS (
        SELECT id FROM notificaciones WHERE push_estado IN ('pendiente','enviando','recibo')
          AND COALESCE(push_proximo,NOW()) <= NOW()
        ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 5
      ) UPDATE notificaciones n SET push_estado=CASE WHEN n.push_estado='recibo' THEN 'recibo' ELSE 'enviando' END,
        push_proximo=NOW()+INTERVAL '5 minutes',push_intentos=COALESCE(n.push_intentos,0)+1,
        push_token_enviado=CASE WHEN n.push_estado='recibo' THEN n.push_token_enviado ELSE (SELECT push_token FROM usuarios WHERE id=n.usuario_id) END
      FROM ready WHERE n.id=ready.id RETURNING n.*,EXTRACT(EPOCH FROM ((CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - n.fecha)) AS age_seconds`)).rows;
      for (const row of rows) {
        try {
          if (row.push_estado !== 'recibo' && Number(row.age_seconds) > 3600) {
            await finish(row, 'expirada');
          } else if (row.push_estado === 'recibo') await receipt(row);
          else await send(row);
        } catch (error) {
          const retry = error.retryable !== false && row.push_intentos < 8;
          await finish(row, retry ? (row.push_estado === 'recibo' ? 'recibo' : 'pendiente') : 'fallida',
            error.code || error.name, row.push_estado === 'recibo' ? row.push_ticket : null, retrySeconds(row.push_intentos));
        }
      }
    } catch (error) { logger.error('Pipa push worker failed:', error.code || error.name); }
    finally { running = false; }
  }
  return { tick };
}
module.exports = { createPushWorker, validToken, retrySeconds };
