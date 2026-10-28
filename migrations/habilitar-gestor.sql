-- Ejecutar en la base de AquaPaz después de la migración 007_reportes_gestion.sql.
-- Requiere que gestor@gmail.com ya esté registrado; no crea usuarios ni cambia contraseñas.
-- Con psql: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/habilitar-gestor.sql
BEGIN;
DO $$
DECLARE
  cuenta_id INTEGER;
BEGIN
  SELECT id INTO STRICT cuenta_id
  FROM usuarios
  WHERE lower(btrim(email)) = 'gestor@gmail.com'
  FOR UPDATE;

  INSERT INTO gestion_roles (usuario_id, rol)
  VALUES (cuenta_id, 'gestor')
  ON CONFLICT (usuario_id) DO UPDATE SET rol = EXCLUDED.rol;
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    RAISE EXCEPTION 'La cuenta gestor@gmail.com no está registrada. Regístrala antes de otorgar acceso.';
  WHEN TOO_MANY_ROWS THEN
    RAISE EXCEPTION 'Hay varias cuentas con ese correo. Revisa la identidad antes de otorgar acceso.';
END $$;

SELECT u.id, u.email, g.rol
FROM usuarios u JOIN gestion_roles g ON g.usuario_id = u.id
WHERE lower(btrim(u.email)) = 'gestor@gmail.com';
COMMIT;
