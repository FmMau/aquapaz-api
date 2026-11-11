ALTER TABLE notificaciones ADD COLUMN IF NOT EXISTS reporte_id INTEGER REFERENCES reportes(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS notificaciones_reporte_destinatario
  ON notificaciones(usuario_id,reporte_id,evento) WHERE reporte_id IS NOT NULL;

CREATE OR REPLACE FUNCTION notificar_reporte_colonia() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE detalle TEXT;
BEGIN
  IF current_setting('aquapaz.restoring', true) = 'on' THEN RETURN NEW; END IF;
  IF NEW.usuario_id IS NULL THEN RETURN NEW; END IF;
  detalle := CASE WHEN NEW.tipo='fuga' THEN 'una fuga de agua'
    WHEN NEW.estado='no_agua' THEN 'falta de agua'
    WHEN NEW.estado='baja_presion' THEN 'baja presión'
    ELSE 'que ya tiene agua' END;
  INSERT INTO notificaciones(usuario_id,reporte_id,evento,titulo,mensaje,tipo)
    SELECT u.id,NEW.id,'reporte_creado','Reporte en '||NEW.colonia,
      'Un vecino reportó '||detalle||' en tu colonia. ¿También te pasa?', 'reporte'
    FROM usuarios u WHERE u.colonia=NEW.colonia AND u.id<>NEW.usuario_id
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS reportes_aviso_colonia ON reportes;
CREATE TRIGGER reportes_aviso_colonia AFTER INSERT ON reportes
  FOR EACH ROW EXECUTE FUNCTION notificar_reporte_colonia();

CREATE OR REPLACE FUNCTION actualizar_aviso_confirmado() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('aquapaz.restoring', true) = 'on' THEN RETURN NEW; END IF;
  UPDATE notificaciones SET leido=true,confirmada=(NEW.decision='confirmar')
    WHERE reporte_id=NEW.reporte_id AND usuario_id=NEW.usuario_id;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS confirmaciones_actualizar_aviso ON confirmaciones;
CREATE TRIGGER confirmaciones_actualizar_aviso AFTER INSERT OR UPDATE ON confirmaciones
  FOR EACH ROW EXECUTE FUNCTION actualizar_aviso_confirmado();
