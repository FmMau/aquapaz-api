CREATE INDEX IF NOT EXISTS reportes_colonia_fecha ON reportes(colonia, fecha DESC NULLS LAST, id DESC);
CREATE INDEX IF NOT EXISTS notificaciones_usuario_id ON notificaciones(usuario_id, id DESC);
