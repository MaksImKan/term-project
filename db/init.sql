-- Ініціалізація локальної БД. Виконується образом postgres лише при першому
-- створенні тому (docker compose down -v скидає його й запускає скрипт знову).
--
-- Пароль ролі marketplace НЕ задається тут: його бере сам образ із
-- POSTGRES_PASSWORD_FILE = /run/secrets/db_password, тобто з того самого
-- файла ./secrets/db_password, який читає застосунок. Завдяки цьому після
-- `docker compose down -v` стартовий пароль БД завжди збігається з файлом,
-- навіть якщо між тим була ротація.

CREATE TABLE IF NOT EXISTS products (
  id           TEXT PRIMARY KEY,
  name         TEXT        NOT NULL,
  price_cents  INTEGER     NOT NULL CHECK (price_cents >= 0), -- цілі копійки, без float
  currency     TEXT        NOT NULL DEFAULT 'UAH',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO products (id, name, price_cents, currency) VALUES
  ('p_1', 'Mechanical Keyboard', 2600, 'UAH'),
  ('p_2', 'Wireless Mouse',       900, 'UAH'),
  ('p_3', 'USB-C Hub',           1500, 'UAH'),
  ('p_4', 'Laptop Stand',        1200, 'UAH'),
  ('p_5', 'Noise-cancelling Headphones', 5400, 'UAH')
ON CONFLICT (id) DO NOTHING;
