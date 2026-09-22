-- =============================================================================
-- Marketplace API — наповнення бази реалістичним обсягом (ДЗ-12)
--
--   users        50 000
--   products    120 000   ← таблиця, по якій іде пошук (q4)
--   orders      200 000   ← головна таблиця
--   order_items ~400 000
--
-- Чому такий обсяг: на тисячі рядків EXPLAIN не показує нічого — планер
-- справедливо бере Seq Scan за будь-яких індексів, бо піти в індекс і потім у
-- heap дорожче, ніж прочитати всю таблицю. Ефект індексів видно лише під
-- обсягом.
--
-- Розподіли перекошені, як у житті:
--   * статуси замовлень   — 42/22/18/13/5, а не рівномірно;
--   * активність покупців — power(random(), 3): невелика група купує багато;
--   * ціни                — power(random(), 3): дешевого багато, дорогого мало;
--   * дати                — power(random(), 2): свіжих замовлень більше;
--   * назви товарів       — зважений словник, у якому «шкіряні» × «кросівки»
--                           дають ~1% каталогу (селективність під q4).
--
-- random() дає інші дані на кожному запуску — це нормально, критерії залежать
-- від обсягу й перекосу, а не від конкретних значень. Усе, на що посилаються
-- запити q1/q3 (id покупця, email), виводиться з номера рядка детерміновано.
--
-- Чому генератор випадкових чисел загорнутий у `WITH gen AS MATERIALIZED`:
-- підзапит без кореляції із зовнішнім рядком (`CROSS JOIN LATERAL (SELECT
-- random())`) планер виконує ОДИН раз на весь INSERT — і всі 200 000 замовлень
-- отримують однаковий статус та одного покупця. MATERIALIZED-CTE рахує рядок
-- на рядок, і кожне значення в ньому можна перевикористати кілька разів
-- (created_at потрібен і сам собою, і для paid_at) без повторного random().
-- =============================================================================

TRUNCATE order_items, orders, products, users RESTART IDENTITY;

-- -----------------------------------------------------------------------------
-- users: 50 000. Імена виводяться з номера рядка (не random!), тому email
-- користувача №31337 однаковий після будь-якого перезаливання — на нього
-- посилається db/queries/q3.sql.
-- -----------------------------------------------------------------------------
WITH gen AS MATERIALIZED (
  SELECT i,
         random() AS r_city,
         random() AS r_active,
         random() AS r_age
  FROM generate_series(1, 50000) AS g(i)
)
INSERT INTO users (email, full_name, city, is_active, created_at)
SELECT
  (ARRAY['Olena','Andrii','Mykola','Iryna','Petro','Sofiia',
         'Taras','Kateryna','Dmytro','Yuliia','Bohdan','Nataliia'])[1 + (i % 12)]
    || '.' ||
  (ARRAY['Shevchenko','Kovalenko','Bondarenko','Tkachuk','Melnyk','Kravchuk',
         'Oliinyk','Shevchuk','Polishchuk','Boiko','Moroz','Lysenko'])[1 + ((i / 12) % 12)]
    || '.' || i || '@example.com'                                    AS email,
  (ARRAY['Олена','Андрій','Микола','Ірина','Петро','Софія',
         'Тарас','Катерина','Дмитро','Юлія','Богдан','Наталія'])[1 + (i % 12)]
    || ' ' ||
  (ARRAY['Шевченко','Коваленко','Бондаренко','Ткачук','Мельник','Кравчук',
         'Олійник','Шевчук','Поліщук','Бойко','Мороз','Лисенко'])[1 + ((i / 12) % 12)]
                                                                     AS full_name,
  CASE
    WHEN r_city < 0.34 THEN 'Київ'
    WHEN r_city < 0.46 THEN 'Львів'
    WHEN r_city < 0.56 THEN 'Харків'
    WHEN r_city < 0.65 THEN 'Одеса'
    WHEN r_city < 0.73 THEN 'Дніпро'
    WHEN r_city < 0.80 THEN 'Запоріжжя'
    WHEN r_city < 0.86 THEN 'Вінниця'
    WHEN r_city < 0.91 THEN 'Івано-Франківськ'
    WHEN r_city < 0.96 THEN 'Полтава'
    ELSE 'Чернівці'
  END                                                                AS city,
  r_active < 0.93                                                    AS is_active,
  now() - (power(r_age, 2) * 900)::int * interval '1 day'             AS created_at
FROM gen;

-- -----------------------------------------------------------------------------
-- products: 120 000 з українськими назвами й описами.
--
-- Українська тут не косметика: на латиниці обидві словоформи в перевірці
-- морфології дали б по нулю, і сенс завдання зник би.
--
-- Словник зважений так, щоб пара «шкіряні» + «кросівки» покривала ~1% каталогу.
-- Якби збігів було 30%+, планер справедливо взяв би Seq Scan навіть за живого
-- GIN-індексу — і критерій «після індексів немає Seq Scan» завалився б.
--
-- Усі іменники — у множині, усі прикметники — у формі множини, тож будь-яка
-- пара узгоджена: «шкіряні кросівки», «шкіряні сумки», «бавовняні футболки».
-- -----------------------------------------------------------------------------
WITH gen AS MATERIALIZED (
  SELECT i,
         random() AS r_noun,
         random() AS r_adj,
         random() AS r_seller,
         random() AS r_price,
         random() AS r_stock,
         random() AS r_pub,
         random() AS r_age
  FROM generate_series(1, 120000) AS g(i)
),
noun (word, lo, hi) AS (VALUES
  ('кросівки',   0.00, 0.10),   -- 10% — цільове слово q4
  ('футболки',   0.10, 0.23),
  ('сумки',      0.23, 0.35),
  ('куртки',     0.35, 0.45),
  ('черевики',   0.45, 0.54),
  ('рюкзаки',    0.54, 0.62),
  ('навушники',  0.62, 0.70),
  ('сорочки',    0.70, 0.77),
  ('ноутбуки',   0.77, 0.83),
  ('гаманці',    0.83, 0.89),
  ('смартфони',  0.89, 0.95),
  ('валізи',     0.95, 1.01)
),
adj (word, lo, hi) AS (VALUES
  ('шкіряні',         0.00, 0.10),   -- 10% — цільове слово q4
  ('спортивні',       0.10, 0.24),
  ('класичні',        0.24, 0.36),
  ('зимові',          0.36, 0.47),
  ('літні',           0.47, 0.57),
  ('дитячі',          0.57, 0.66),
  ('замшеві',         0.66, 0.74),
  ('бавовняні',       0.74, 0.82),
  ('водонепроникні',  0.82, 0.89),
  ('вовняні',         0.89, 0.95),
  ('джинсові',        0.95, 1.01)
)
INSERT INTO products (seller_id, name, description, price, currency, stock, is_published, created_at)
SELECT
  1 + (power(gen.r_seller, 2) * 49999)::int                          AS seller_id,
  initcap(a.word) || ' ' || n.word                                   AS name,
  -- В описі ті самі два слова повторюються у нижньому регістрі свідомо: так
  -- лексеми 'шкіряні' і 'кросівки' присутні у search_vector навіть там, де
  -- локаль бази не вміє знижувати регістр кирилиці (musl-образи, locale=C).
  'Оригінальні ' || a.word || ' ' || n.word || ' від бренду '
    || (ARRAY['Vesna','Karpaty','Dnipro','Zoria','Sokil','Halyt','Berehynia','Tysa'])[1 + (gen.i % 8)]
    || '. ' ||
  (ARRAY['Гарантія 12 місяців.','Безкоштовна доставка від 1000 грн.',
         'Новинка сезону.','Топ продажів минулого місяця.',
         'Залишились останні розміри.','Повернення протягом 14 днів.'])[1 + (gen.i % 6)]
    || ' Колір: ' ||
  (ARRAY['чорний','білий','синій','бежевий','червоний','сірий','зелений','коричневий'])[1 + (gen.i % 8)]
    || '. Артикул ' || gen.i || '.'                                  AS description,
  round((50 + power(gen.r_price, 3) * 29950)::numeric, 2)            AS price,
  'UAH'                                                              AS currency,
  (power(gen.r_stock, 2) * 250)::int                                 AS stock,
  gen.r_pub < 0.95                                                   AS is_published,
  now() - (power(gen.r_age, 2) * 730)::int * interval '1 day'        AS created_at
FROM gen
JOIN noun n ON gen.r_noun >= n.lo AND gen.r_noun < n.hi
JOIN adj  a ON gen.r_adj  >= a.lo AND gen.r_adj  < a.hi;

-- -----------------------------------------------------------------------------
-- orders: 200 000. Статуси перекошені (delivered 42% … pending 5%) — саме
-- завдяки цьому partial-індекс під q2 має сенс: він накриває 5% таблиці.
-- Покупці перекошені через power(random(), 3): id з початку діапазону
-- набирають десятки й сотні замовлень, як активні клієнти в житті.
-- -----------------------------------------------------------------------------
WITH gen AS MATERIALIZED (
  SELECT i,
         random() AS r_buyer,
         random() AS r_status,
         random() AS r_paid,
         now() - (power(random(), 2) * 540)::int * interval '1 day' AS created_at
  FROM generate_series(1, 200000) AS g(i)
),
status_w (status, lo, hi) AS (VALUES
  ('delivered', 0.00, 0.42),
  ('shipped',   0.42, 0.64),
  ('paid',      0.64, 0.82),
  ('cancelled', 0.82, 0.95),
  ('pending',   0.95, 1.01)
)
INSERT INTO orders (buyer_id, status, total_amount, currency, created_at, paid_at)
SELECT
  1 + (power(gen.r_buyer, 3) * 49999)::int                           AS buyer_id,
  s.status                                                           AS status,
  0                                                                  AS total_amount,
  'UAH'                                                              AS currency,
  gen.created_at                                                     AS created_at,
  CASE
    WHEN s.status = 'pending'                          THEN NULL
    WHEN s.status = 'cancelled' AND gen.r_paid < 0.45  THEN NULL
    ELSE gen.created_at + (gen.r_paid * 72)::int * interval '1 hour'
  END                                                                AS paid_at
FROM gen
JOIN status_w s ON gen.r_status >= s.lo AND gen.r_status < s.hi;

-- -----------------------------------------------------------------------------
-- order_items: 1..3 позиції на замовлення (~400 000 рядків).
-- product_id вибирається арифметично (два взаємно простих множники), тож
-- позиції одного замовлення гарантовано різні — інакше UNIQUE (order_id,
-- product_id) відбив би вставку.
-- unit_price — копія ціни на момент купівлі, а не посилання на каталог.
-- -----------------------------------------------------------------------------
INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT
  o.id                                                               AS order_id,
  p.id                                                               AS product_id,
  1 + (random() * 3)::int                                            AS quantity,
  p.price                                                            AS unit_price
FROM orders o
CROSS JOIN generate_series(1, 1 + (o.id % 3)) AS s(n)
JOIN products p ON p.id = 1 + ((o.id * 7919 + s.n * 104729) % 120000);

-- Сума замовлення мусить дорівнювати сумі позицій, інакше дані брешуть.
UPDATE orders o
SET total_amount = t.total
FROM (
  SELECT order_id, sum(quantity * unit_price) AS total
  FROM order_items
  GROUP BY order_id
) AS t
WHERE t.order_id = o.id;

-- -----------------------------------------------------------------------------
-- Саме VACUUM (ANALYZE), а не ANALYZE.
--
-- ANALYZE дає планеру статистику — цього достатньо, щоб він вибрав індекс.
-- Але visibility map виставляє лише VACUUM, а без неї Index Only Scan усе одно
-- лізе в таблицю за видимістю (Heap Fetches: N у плані), і buffers «після»
-- виходять у сотні разів гіршими, ніж могли б.
-- Плюс UPDATE вище залишив по мертвому рядку на кожне замовлення — VACUUM
-- повертає ці сторінки.
--
-- Таблиці перелічені явно: VACUUM без списку намагається зачепити ще й спільні
-- каталоги кластера й сипле WARNING-ами, якщо роль не суперкористувач.
-- -----------------------------------------------------------------------------
VACUUM (ANALYZE) users, products, orders, order_items;
