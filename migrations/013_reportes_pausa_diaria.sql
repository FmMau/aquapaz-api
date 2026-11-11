ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reportes_silenciados_hasta TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION pausar_avisos_reportes() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('aquapaz.restoring', true) = 'on' THEN RETURN NEW; END IF;
  IF NEW.decision = 'confirmar' THEN
    UPDATE usuarios SET reportes_silenciados_hasta =
      ((NOW() AT TIME ZONE 'America/Mazatlan')::date + 1)::timestamp AT TIME ZONE 'America/Mazatlan'
      WHERE id=NEW.usuario_id;
    UPDATE web_push_deliveries d SET state='expired'
      FROM notificaciones n WHERE n.id=d.notification_id AND n.usuario_id=NEW.usuario_id
        AND n.tipo='reporte' AND d.state IN ('pending','sending');
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS confirmaciones_pausa_diaria ON confirmaciones;
CREATE TRIGGER confirmaciones_pausa_diaria AFTER INSERT ON confirmaciones
  FOR EACH ROW EXECUTE FUNCTION pausar_avisos_reportes();

CREATE OR REPLACE FUNCTION filtrar_avisos_reportes() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tipo='reporte' AND EXISTS (SELECT 1 FROM usuarios
    WHERE id=NEW.usuario_id AND reportes_silenciados_hasta>NOW()) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS notificaciones_pausa_diaria ON notificaciones;
CREATE TRIGGER notificaciones_pausa_diaria BEFORE INSERT ON notificaciones
  FOR EACH ROW EXECUTE FUNCTION filtrar_avisos_reportes();
