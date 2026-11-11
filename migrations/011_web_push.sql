CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  endpoint TEXT UNIQUE NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions(user_id);
CREATE TABLE IF NOT EXISTS web_push_deliveries (
  id SERIAL PRIMARY KEY,
  notification_id INTEGER NOT NULL REFERENCES notificaciones(id) ON DELETE CASCADE,
  subscription_id INTEGER NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','sent','failed','expired')),
  next_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE(notification_id, subscription_id)
);
CREATE INDEX IF NOT EXISTS web_push_ready ON web_push_deliveries(next_at) WHERE state IN ('pending','sending');
CREATE OR REPLACE FUNCTION clear_rebound_web_push() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    DELETE FROM web_push_deliveries WHERE subscription_id=OLD.id;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS push_subscription_rebind ON push_subscriptions;
CREATE TRIGGER push_subscription_rebind BEFORE UPDATE ON push_subscriptions
  FOR EACH ROW EXECUTE FUNCTION clear_rebound_web_push();
CREATE OR REPLACE FUNCTION enqueue_web_push() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('aquapaz.restoring', true) = 'on' THEN RETURN NEW; END IF;
  INSERT INTO web_push_deliveries(notification_id,subscription_id,expires_at)
    SELECT NEW.id,s.id,NOW()+CASE WHEN NEW.evento LIKE 'oferta:%' THEN INTERVAL '60 seconds' ELSE INTERVAL '1 hour' END
    FROM push_subscriptions s WHERE s.user_id=NEW.usuario_id;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS notificaciones_web_push ON notificaciones;
CREATE TRIGGER notificaciones_web_push AFTER INSERT ON notificaciones
  FOR EACH ROW EXECUTE FUNCTION enqueue_web_push();
