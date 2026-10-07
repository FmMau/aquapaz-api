-- Events and the push queue commit with the order. No historical events are replayed.
-- Tokens with ambiguous ownership must be registered again by a signed-in device.
UPDATE usuarios SET push_token=NULL WHERE push_token IN (
  SELECT push_token FROM usuarios WHERE push_token IS NOT NULL GROUP BY push_token HAVING COUNT(*)>1
);
ALTER TABLE notificaciones ADD COLUMN IF NOT EXISTS pedido_id INTEGER;
ALTER TABLE notificaciones ADD COLUMN IF NOT EXISTS evento TEXT;
ALTER TABLE notificaciones ADD COLUMN IF NOT EXISTS destinatario TEXT;
ALTER TABLE notificaciones ADD COLUMN IF NOT EXISTS titulo TEXT;
ALTER TABLE notificaciones ADD COLUMN IF NOT EXISTS push_estado TEXT;
ALTER TABLE notificaciones ADD COLUMN IF NOT EXISTS push_intentos INTEGER;
ALTER TABLE notificaciones ADD COLUMN IF NOT EXISTS push_proximo TIMESTAMPTZ;
ALTER TABLE notificaciones ADD COLUMN IF NOT EXISTS push_ticket TEXT;
ALTER TABLE notificaciones ADD COLUMN IF NOT EXISTS push_token_enviado TEXT;
ALTER TABLE notificaciones ADD COLUMN IF NOT EXISTS push_error TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS notificaciones_pipa_evento
  ON notificaciones (usuario_id, pedido_id, evento) WHERE pedido_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS notificaciones_push_pendiente
  ON notificaciones (push_proximo) WHERE push_estado IN ('pendiente','enviando','recibo');

CREATE OR REPLACE FUNCTION notificar_pedido_pipa() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  operador_usuario INTEGER;
  evento_cliente TEXT;
  mensaje_cliente TEXT;
  evento_operador TEXT;
  mensaje_operador TEXT;
BEGIN
  -- Restoring a backup must not create events or send old notifications again.
  IF current_setting('aquapaz.restoring', true) = 'on' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.estado = 'solicitada' THEN
      INSERT INTO notificaciones (usuario_id,pedido_id,evento,destinatario,titulo,mensaje,tipo,push_estado,push_intentos,push_proximo)
      SELECT o.usuario_id,NEW.id,'solicitada','operador','Nueva solicitud de agua',
        'Hay una solicitud de ' || NEW.litros || ' litros en ' || NEW.colonia || '. Revisa si sigue disponible.',
        'pipa','pendiente',0,NOW()
      FROM operadores_pipa o WHERE o.disponible AND o.capacidad >= NEW.litros AND o.usuario_id <> NEW.usuario_id
        AND NOT EXISTS (SELECT 1 FROM pedidos_pipa p WHERE p.operador_id=o.id AND p.estado NOT IN ('completada','cancelada'))
      ON CONFLICT DO NOTHING;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.estado IS NOT DISTINCT FROM OLD.estado AND NEW.cotizacion_version IS NOT DISTINCT FROM OLD.cotizacion_version
    AND NEW.precio_aceptado_en IS NOT DISTINCT FROM OLD.precio_aceptado_en THEN RETURN NEW; END IF;
  SELECT usuario_id INTO operador_usuario FROM operadores_pipa WHERE id=NEW.operador_id;
  IF NEW.estado IS DISTINCT FROM OLD.estado THEN
    CASE NEW.estado
      WHEN 'asignada' THEN evento_cliente := 'asignada'; mensaje_cliente := 'Un operador tomó tu pedido. Espera su cotización.';
      WHEN 'en_camino' THEN evento_cliente := 'en_camino'; mensaje_cliente := 'Tu pipa está en camino. Abre el pedido para ver su ubicación.';
      WHEN 'en_sitio' THEN evento_cliente := 'en_sitio'; mensaje_cliente := 'El operador indicó que llegó al punto de entrega.';
      WHEN 'completada' THEN evento_cliente := 'completada'; mensaje_cliente := 'El operador confirmó la entrega del agua.';
      WHEN 'cancelada' THEN
        evento_cliente := 'cancelada'; mensaje_cliente := 'Tu pedido fue cancelado.';
        evento_operador := 'cancelada'; mensaje_operador := 'El cliente canceló el pedido. Revisa tus entregas.';
      ELSE NULL;
    END CASE;
  END IF;
  IF NEW.estado='asignada' AND NEW.precio_centavos IS NOT NULL AND NEW.cotizacion_version IS DISTINCT FROM OLD.cotizacion_version THEN
    evento_cliente := 'cotizacion:' || NEW.cotizacion_version;
    mensaje_cliente := 'Recibiste una cotización. Revisa el precio y el tiempo estimado antes de aceptar.';
  END IF;
  IF NEW.precio_aceptado_en IS NOT NULL AND OLD.precio_aceptado_en IS NULL THEN
    evento_operador := 'precio_aceptado:' || NEW.cotizacion_version;
    mensaje_operador := 'El cliente aceptó tu cotización. Ya puedes iniciar el viaje.';
  END IF;
  IF evento_cliente IS NOT NULL THEN
    INSERT INTO notificaciones (usuario_id,pedido_id,evento,destinatario,titulo,mensaje,tipo,push_estado,push_intentos,push_proximo)
    VALUES (NEW.usuario_id,NEW.id,evento_cliente,'cliente','Tu pedido de agua',mensaje_cliente,'pipa','pendiente',0,NOW()) ON CONFLICT DO NOTHING;
  END IF;
  IF evento_operador IS NOT NULL AND operador_usuario IS NOT NULL THEN
    INSERT INTO notificaciones (usuario_id,pedido_id,evento,destinatario,titulo,mensaje,tipo,push_estado,push_intentos,push_proximo)
    VALUES (operador_usuario,NEW.id,evento_operador,'operador','Tus entregas de agua',mensaje_operador,'pipa','pendiente',0,NOW()) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS pedidos_pipa_notificaciones ON pedidos_pipa;
CREATE TRIGGER pedidos_pipa_notificaciones AFTER INSERT OR UPDATE ON pedidos_pipa
  FOR EACH ROW EXECUTE FUNCTION notificar_pedido_pipa();
