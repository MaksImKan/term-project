# Оптимізація запитів дата-шару (ДЗ-12)

Стенд: PostgreSQL 16.13, `shared_buffers = 256MB`, дані з `db/seed.sql` —
50 000 користувачів, 120 000 товарів, 200 000 замовлень, 400 001 позиція замовлення.
Усі числа зняті на теплому кеші (у планах `shared hit`, без `read`), тож порівнюються
однакові умови «до» і «після». На холодному кеші абсолютні значення будуть більшими,
порядок величини — той самий.

Порядок прогону — рівно той, що й у грейдера:

```bash
docker compose down -v && docker compose up -d --wait      # чистий volume
psql -f db/schema.sql
psql -f db/seed.sql                                        # закінчується VACUUM (ANALYZE)
psql -c "EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/q1.sql)"   # ... q2, q3, q4 — Seq Scan
psql -f db/indexes.sql
psql -c "ANALYZE"
psql -c "EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/q1.sql)"   # ... q2, q3, q4 — індексні плани
```

## Підсумок

| Запит | Що це в API | Execution Time до, мс | після, мс | Прискорення | Buffers (shared hit) | Індекс у вузлі плану |
| --- | --- | --- | --- | --- | --- | --- |
| q1 | замовлення покупця за період | 15.546 | 0.230 | **68×** | 3 985 → 56 | `idx_orders_buyer_created_at` |
| q2 | черга необроблених замовлень | 14.416 | 0.294 | **49×** | 3 985 → 90 | `idx_orders_pending_created_at` |
| q3 | email без урахування регістру | 21.469 | 0.036 | **596×** | 755 → 4 | `idx_users_lower_email` |
| q4 | повнотекстовий пошук каталогу | 33.446 | 5.827 | **6×** | 8 578 → 1 088 | `idx_products_search_vector` |

Жоден із чотирьох індексів не лишився мертвим — після прогону всіх «після»:

```
          indexrelname           | idx_scan
---------------------------------+----------
 idx_orders_buyer_created_at     |        3
 idx_orders_pending_created_at   |        3
 idx_products_search_vector      |        3
 idx_users_lower_email           |        3
```

(по 3 — бо кожен «після» прогнано тричі; перевірка на мертві індекси віддає порожньо).

---

## q1 — замовлення покупця за період

`GET /orders?buyer_id=7&from=…&to=…` — найчастіший запит кабінету покупця.

```sql
SELECT id, status, total_cents, currency, created_at
FROM orders
WHERE buyer_id = 7
  AND created_at >= now() - interval '90 days'
  AND created_at <  now() - interval '30 days'
ORDER BY created_at DESC
LIMIT 50
```

**Індекс:** `idx_orders_buyer_created_at` — `orders (buyer_id, created_at DESC)`

### EXPLAIN (ANALYZE, BUFFERS) — до індексів

```
                                                                   QUERY PLAN                                                                    
-------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=7203.86..7209.69 rows=50 width=32) (actual time=15.115..15.507 rows=50 loops=1)
   Buffers: shared hit=3985
   ->  Gather Merge  (cost=7203.86..7213.89 rows=86 width=32) (actual time=15.113..15.500 rows=50 loops=1)
         Workers Planned: 2
         Workers Launched: 2
         Buffers: shared hit=3985
         ->  Sort  (cost=6203.83..6203.94 rows=43 width=32) (actual time=10.946..10.949 rows=32 loops=3)
               Sort Key: created_at DESC
               Sort Method: quicksort  Memory: 27kB
               Buffers: shared hit=3985
               Worker 0:  Sort Method: quicksort  Memory: 26kB
               Worker 1:  Sort Method: quicksort  Memory: 28kB
               ->  Parallel Seq Scan on orders  (cost=0.00..6202.67 rows=43 width=32) (actual time=0.783..10.858 rows=35 loops=3)
                     Filter: ((buyer_id = 7) AND (created_at >= (now() - '90 days'::interval)) AND (created_at < (now() - '30 days'::interval)))
                     Rows Removed by Filter: 66631
                     Buffers: shared hit=3911
 Planning:
   Buffers: shared hit=130
 Planning Time: 0.443 ms
 Execution Time: 15.546 ms
```

### EXPLAIN (ANALYZE, BUFFERS) — після індексів

```
                                                                   QUERY PLAN                                                                   
------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=0.43..201.55 rows=50 width=32) (actual time=0.027..0.206 rows=50 loops=1)
   Buffers: shared hit=56
   ->  Index Scan using idx_orders_buyer_created_at on orders  (cost=0.43..414.74 rows=103 width=32) (actual time=0.027..0.200 rows=50 loops=1)
         Index Cond: ((buyer_id = 7) AND (created_at >= (now() - '90 days'::interval)) AND (created_at < (now() - '30 days'::interval)))
         Buffers: shared hit=56
 Planning:
   Buffers: shared hit=168
 Planning Time: 0.447 ms
 Execution Time: 0.230 ms
```

### Що змінилось

У плані «до» стоїть `Parallel Seq Scan on orders`: Postgres читає всі 200 000 рядків
трьома процесами й викидає по 66 631 у кожному (`Rows Removed by Filter`), потім сортує
залишок (`Sort`) і зшиває потоки (`Gather Merge`).

У плані «після» лишився один вузол — `Index Scan using idx_orders_buyer_created_at on orders`.
Зникли три вузли одразу: `Parallel Seq Scan`, `Sort` і `Gather Merge`. Sort зник не сам собою:
індекс складений у порядку «спочатку рівність (`buyer_id`), потім діапазон (`created_at DESC`)»,
тому рядки виходять із індексу вже впорядкованими — `ORDER BY created_at DESC LIMIT 50` бере
перші 50 і зупиняється. Паралельність зникла, бо стала не потрібна: коли роботи на 56 сторінок,
запускати воркерів дорожче, ніж прочитати їх послідовно.

Buffers: **3 985 → 56** сторінок. Читання цілої таблиці замінилось на спуск по дереву індексу
плюс похід у heap за 50 потрібними рядками.

---

## q2 — черга необроблених замовлень

`GET /orders?status=pending` — те, що бачить оператор у панелі обробки.

```sql
SELECT id, buyer_id, total_cents, currency, created_at
FROM orders
WHERE status = 'pending'
ORDER BY created_at DESC
LIMIT 100
```

**Індекс:** `idx_orders_pending_created_at` — `orders (created_at DESC) WHERE status = 'pending'` (**partial**)

### EXPLAIN (ANALYZE, BUFFERS) — до індексів

```
                                                              QUERY PLAN                                                              
--------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=6113.21..6124.88 rows=100 width=32) (actual time=14.093..14.377 rows=100 loops=1)
   Buffers: shared hit=3985
   ->  Gather Merge  (cost=6113.21..7093.28 rows=8400 width=32) (actual time=14.091..14.367 rows=100 loops=1)
         Workers Planned: 2
         Workers Launched: 2
         Buffers: shared hit=3985
         ->  Sort  (cost=5113.19..5123.69 rows=4200 width=32) (actual time=10.681..10.686 rows=96 loops=3)
               Sort Key: created_at DESC
               Sort Method: top-N heapsort  Memory: 36kB
               Buffers: shared hit=3985
               Worker 0:  Sort Method: top-N heapsort  Memory: 36kB
               Worker 1:  Sort Method: top-N heapsort  Memory: 36kB
               ->  Parallel Seq Scan on orders  (cost=0.00..4952.67 rows=4200 width=32) (actual time=0.178..10.090 rows=3342 loops=3)
                     Filter: (status = 'pending'::text)
                     Rows Removed by Filter: 63324
                     Buffers: shared hit=3911
 Planning:
   Buffers: shared hit=125
 Planning Time: 0.346 ms
 Execution Time: 14.416 ms
```

### EXPLAIN (ANALYZE, BUFFERS) — після індексів

```
                                                                      QUERY PLAN                                                                       
-------------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=0.29..156.02 rows=100 width=32) (actual time=0.025..0.271 rows=100 loops=1)
   Buffers: shared hit=90
   ->  Index Scan using idx_orders_pending_created_at on orders  (cost=0.29..15843.70 rows=10173 width=32) (actual time=0.024..0.260 rows=100 loops=1)
         Buffers: shared hit=90
 Planning:
   Buffers: shared hit=157
 Planning Time: 0.474 ms
 Execution Time: 0.294 ms
```

### Що змінилось

«До» — той самий `Parallel Seq Scan on orders` на 200 000 рядків, з `Filter: (status =
'pending'::text)` і `top-N heapsort` над 10 027 знайденими.

«Після» — `Index Scan using idx_orders_pending_created_at on orders`. Зверни увагу: у вузлі
немає ані `Index Cond`, ані `Filter` — умова `status = 'pending'` не перевіряється в рантаймі
взагалі, бо в індексі фізично немає інших рядків. Це і є суть partial: предикат винесено в
означення індексу, тож він коштує нуль на кожному запиті.

Повний індекс по `(status, created_at)` тут був би гіршим вибором: він у ~20 разів більший
(200 000 записів проти 10 027), і планер узагалі міг би його проігнорувати — 5% таблиці за
одним лише статусом це та межа, де похід у індекс перестає бути очевидно вигідним.

Buffers: **3 985 → 90**, `Sort` зник (індекс уже впорядкований по `created_at DESC`).

---

## q3 — пошук користувача за email без урахування регістру

`GET /users?email=…` — логін та підтримка, де користувач вводить email як завгодно.

```sql
SELECT id, email, full_name, city, created_at
FROM users
WHERE lower(email) = lower('Sofiia.Shevchuk.31337@example.com')
```

**Індекс:** `idx_users_lower_email` — `users (lower(email))` (**expression**, UNIQUE)

### EXPLAIN (ANALYZE, BUFFERS) — до індексів

```
                                              QUERY PLAN                                               
-------------------------------------------------------------------------------------------------------
 Seq Scan on users  (cost=0.00..1505.00 rows=250 width=89) (actual time=13.232..21.447 rows=1 loops=1)
   Filter: (lower(email) = 'sofiia.shevchuk.31337@example.com'::text)
   Rows Removed by Filter: 49999
   Buffers: shared hit=755
 Planning:
   Buffers: shared hit=120
 Planning Time: 0.324 ms
 Execution Time: 21.469 ms
```

### EXPLAIN (ANALYZE, BUFFERS) — після індексів

```
                                                          QUERY PLAN                                                          
------------------------------------------------------------------------------------------------------------------------------
 Index Scan using idx_users_lower_email on users  (cost=0.41..8.43 rows=1 width=89) (actual time=0.016..0.016 rows=1 loops=1)
   Index Cond: (lower(email) = 'sofiia.shevchuk.31337@example.com'::text)
   Buffers: shared hit=4
 Planning:
   Buffers: shared hit=140
 Planning Time: 0.428 ms
 Execution Time: 0.036 ms
```

### Що змінилось

«До» — `Seq Scan on users` по всіх 50 000 рядків, щоб знайти **один**. І тут важливо,
чому не допоміг би звичайний індекс: у `WHERE` стоїть не колонка, а **функція** від колонки —
`lower(email)`. Індекс по `email` зберігає `Sofiia.Shevchuk.31337@example.com`, а запит шукає
`sofiia.shevchuk.31337@example.com`; для B-tree це різні значення, і індекс не застосовний.
Саме цей випадок ловить підказка «в WHERE стоїть функція, а індекс — по колонці».

«Після» — `Index Scan using idx_users_lower_email on users`, `Index Cond: (lower(email) =
'sofiia.shevchuk.31337@example.com'::text)`. Індекс побудований по тому самому виразу, що стоїть
у запиті, тож планер їх зіставляє.

Buffers: **755 → 4** сторінки (три рівні дерева + одна сторінка heap). Це найбільший виграш із
чотирьох: 21.5 мс → 0.036 мс, бо було «прочитати 50 000 рядків», а стало «прочитати один».

`UNIQUE` на виразі — не про швидкість, а про коректність: він робить неможливою пару
користувачів, що різняться лише регістром email.

---

## q4 — повнотекстовий пошук по каталогу

`GET /products?q=шкіряні+кросівки` — покупець вводить два слова, отримує 20 карток.

```sql
SELECT id, name, ts_rank(search_vector, plainto_tsquery('simple', 'шкіряні кросівки')) AS rank
FROM products
WHERE search_vector @@ plainto_tsquery('simple', 'шкіряні кросівки')
ORDER BY rank DESC, id
LIMIT 20
```

**Індекс:** `idx_products_search_vector` — `products USING GIN (search_vector)`

### EXPLAIN (ANALYZE, BUFFERS) — до індексів

```
                                                        QUERY PLAN                                                        
--------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=10106.41..10106.46 rows=20 width=43) (actual time=33.418..33.422 rows=20 loops=1)
   Buffers: shared hit=8578
   ->  Sort  (cost=10106.41..10109.36 rows=1182 width=43) (actual time=33.416..33.418 rows=20 loops=1)
         Sort Key: (ts_rank(search_vector, '''шкіряні'' & ''кросівки'''::tsquery)) DESC, id
         Sort Method: top-N heapsort  Memory: 26kB
         Buffers: shared hit=8578
         ->  Seq Scan on products  (cost=0.00..10074.95 rows=1182 width=43) (actual time=0.036..33.106 rows=1140 loops=1)
               Filter: (search_vector @@ '''шкіряні'' & ''кросівки'''::tsquery)
               Rows Removed by Filter: 118860
               Buffers: shared hit=8572
 Planning:
   Buffers: shared hit=96
 Planning Time: 0.366 ms
 Execution Time: 33.446 ms
```

### EXPLAIN (ANALYZE, BUFFERS) — після індексів

```
                                                                      QUERY PLAN                                                                      
------------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=3409.68..3409.73 rows=20 width=43) (actual time=5.772..5.776 rows=20 loops=1)
   Buffers: shared hit=1088
   ->  Sort  (cost=3409.68..3412.74 rows=1225 width=43) (actual time=5.770..5.772 rows=20 loops=1)
         Sort Key: (ts_rank(search_vector, '''шкіряні'' & ''кросівки'''::tsquery)) DESC, id
         Sort Method: top-N heapsort  Memory: 26kB
         Buffers: shared hit=1088
         ->  Bitmap Heap Scan on products  (cost=36.48..3377.08 rows=1225 width=43) (actual time=1.461..5.415 rows=1140 loops=1)
               Recheck Cond: (search_vector @@ '''шкіряні'' & ''кросівки'''::tsquery)
               Heap Blocks: exact=1065
               Buffers: shared hit=1082
               ->  Bitmap Index Scan on idx_products_search_vector  (cost=0.00..36.18 rows=1225 width=0) (actual time=1.321..1.321 rows=1140 loops=1)
                     Index Cond: (search_vector @@ '''шкіряні'' & ''кросівки'''::tsquery)
                     Buffers: shared hit=17
 Planning:
   Buffers: shared hit=121
 Planning Time: 0.459 ms
 Execution Time: 5.827 ms
```

### Що змінилось

«До» — `Seq Scan on products` з `Filter: (search_vector @@ '''шкіряні'' & ''кросівки'''::tsquery)`:
Postgres розпаковує tsvector кожного з 120 000 товарів і викидає 118 860. 8 578 сторінок,
33.4 мс.

«Після» — `Bitmap Index Scan on idx_products_search_vector` → `Bitmap Heap Scan on products`.
GIN — інвертований індекс: він зберігає відображення «лексема → список рядків», тож замість
розпаковування 120 000 векторів робить два пошуки по словнику лексем і перетинає списки.
Індексна частина обійшлась у **17 сторінок** замість 8 572.

Чому загальне прискорення тут 6×, а не 50×, як на q1–q3: 1 140 знайдених товарів фізично
розкидані по 1 065 сторінках таблиці (`Heap Blocks: exact=1065`), і за `name` та `search_vector`
для `ts_rank` доводиться йти в heap по кожному. Bitmap Heap Scan — це і є та стеля, в яку
впирається «Postgres-половина» пошуку: індекс знаходить рядки майже безкоштовно, а дістати їх
усе одно треба. Виділені пошукові рушії тримають потрібні для видачі поля всередині власного
індексу — саме тому в маркетплейсах врешті зʼявляється окремий Elasticsearch / OpenSearch.

Buffers: **8 578 → 1 088**. `ORDER BY rank DESC` лишився `top-N heapsort` — GIN не зберігає
`ts_rank`, релевантність рахується вже після вибірки.

Число вище — з третього прогону, як і вимагає умова. На цьому стенді різниці між першим і
третім прогоном практично немає (близько 5–6 мс після перестворення індексу): база на
256 MB `shared_buffers` тримає і таблицю, і 9 MB GIN у памʼяті, тож платити за читання
індексу з диска нема чим. На холодному кеші саме перший виклик і оплачує це читання — тому
правило «прогнати 2–3 рази й узяти останній» лишається в силі, а `db/explain.sh` робить це
за замовчуванням.

---

## Морфологія

Те саме слово, дві словоформи, на тій самій базі (120 000 товарів):

```sql
SELECT count(*) FROM products WHERE search_vector @@ plainto_tsquery('simple', 'кросівки');
-- 11994

SELECT count(*) FROM products WHERE search_vector @@ plainto_tsquery('simple', 'кросівок');
-- 0
```

Базова форма «кросівки» знаходить 11 994 товари, родовий відмінок «кросівок» — рівно 0,
хоча йдеться про той самий товар.

Причина: конфігурація `simple` не має стемера — вона лише знижує регістр і ріже текст на
слова, тож `кросівки` і `кросівок` для неї два різні, нічим не пов'язані рядки. І взяти
український стемер нізвідки:

```sql
SELECT count(*) FROM pg_ts_config;   -- 29
```

```
arabic, armenian, basque, catalan, danish, dutch, english, finnish, french, german,
greek, hindi, hungarian, indonesian, irish, italian, lithuanian, nepali, norwegian,
portuguese, romanian, russian, serbian, simple, spanish, swedish, tamil, turkish, yiddish
```

29 конфігурацій — і жодної української. Те саме видно з `\dF` у psql.

Підміна `simple` на `russian` це не лікує, а маскує — російський стемер ріже українські
слова за чужими правилами:

```sql
SELECT to_tsvector('russian', 'кросівки');   -- 'кросівк':1
SELECT to_tsvector('russian', 'кросівок');   -- 'кросівок':1
```

Основи все одно різні (`кросівк` проти `кросівок`), тобто запит однією формою так само не
знайде іншу — просто тепер ще й непередбачувано, бо правила відсікання належать іншій мові.
Заразом `russian` має власний список стоп-слів, і українські службові слова в нього не
входять.

Що з цим роблять насправді: підключають окремий словник — `ispell`/`hunspell` зі
словниковими файлами української (`uk_UA.aff` + `uk_UA.dic`) і будують на ньому власну
`TEXT SEARCH CONFIGURATION`, або віддають пошук зовнішньому рушію, де українська морфологія
вже є. Обидва шляхи — за межами цього ДЗ; тут важливо було побачити нуль і назвати його
причину, а не приховати.

---

## Ціна збереженої tsvector-колонки

Генерована колонка `search_vector` не безкоштовна, і це нормальна ціна, яку треба вміти
назвати вголос. Заміряно на цій самій базі:

| Що | Без `search_vector` | З `search_vector` | Різниця |
| --- | --- | --- | --- |
| Розмір `products` (heap) | 34 MB | 67 MB | **×2.0** |
| Вставка 50 000 рядків | 248–297 мс | 862–970 мс | **×3.3** |
| Середній розмір значення | — | 280 байт на рядок | при 214 байтах `name + description` |

Плюс сам GIN-індекс — 9 248 kB. Разом `pg_total_relation_size('products')` = 79 MB там, де
без пошуку було б 34 MB.

Тобто пошук по каталогу коштує приблизно подвоєння таблиці, вчетверо дорожчу вставку і
окремий індекс. Альтернатива — expression-індекс `GIN (to_tsvector('simple', name || ' ' ||
description))` без збереженої колонки: він економить місце в heap, але тоді той самий вираз
має бути буквально повторений у кожному запиті, і `ts_rank` рахується щоразу з нуля.

---

## Чому саме чотири індекси і жодного більше

Кожен зайвий індекс — це диск, повільніший `INSERT`/`UPDATE` і робота autovacuum. Тут стоїть
по одному індексу на запит, і кожен доведено використаним (`idx_scan > 0`).

Індексів під `FOREIGN KEY` (`products.seller_id`, `orders.buyer_id`, `order_items.order_id`,
`order_items.product_id`) свідомо **немає**: Postgres, на відміну від MySQL, не створює їх
автоматично і не потребує для перевірки FK з боку дитини. Жоден із q1–q4 їх не використовує,
тож вони лишились би мертвими — а критерій «жоден індекс не мертвий» ловить саме це. Вони
зʼявляться у ДЗ #14 разом із запитами й каскадами, яким справді потрібні.

Індекси під `PRIMARY KEY` та `UNIQUE` (`orders_pkey`, `users_email_unique`,
`order_items_one_row_per_product` тощо) створює сам Postgres під констрейнти — вони тримають
цілісність, а не запити, і нуль сканів для них нормальний.
