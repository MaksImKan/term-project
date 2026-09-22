# Marketplace API — курсовий проєкт

NestJS + `express-openapi-validator` (ДЗ-09), керована конфігурація з ротацією
секретів (ДЗ-11) і дата-шар на Postgres з індексами та повнотекстовим пошуком (ДЗ-12).
Розділ [Configuration](#configuration) — про змінні середовища, запуск і ротацію пароля
БД без рестарту; розділ [Дата-шар](#дата-шар-дз-12) — про схему, seed і `EXPLAIN`.

## Контракт на кордоні (ДЗ-09)

**Обраний варіант: Б — runtime-валідація на кордоні** на **NestJS** + `express-openapi-validator`.

`express-openapi-validator` вішається глобальним middleware і валідує **запити й відповіді**
проти `openapi/openapi.yaml`. Будь-яка помилка (валідатора чи сервісу) перекладається у
`application/problem+json` (RFC 9457) глобальним `ProblemJsonFilter`. Усе, що суперечить
спеці, — відхиляється (у т.ч. невалідна **відповідь**: це runtime-аналог `contract/check.mjs`,
який на лекції ловив `DRIFT=1`).

Версії зафіксовано як у ДЗ: `@redocly/cli 2.46.0`, `express 4.22.2`,
`express-openapi-validator 5.6.2` (NestJS `10.4.22` на платформі express@4).

## Структура

| Файл / тека                     | Призначення                                                   |
| ------------------------------- | ------------------------------------------------------------- |
| `openapi/openapi.yaml`          | Спека: 2 ресурси, 5 операцій, cursor-пагінація, Idempotency-Key, problem+json |
| `src/main.ts`                   | Bootstrap: порядок middleware `json → validator → роути`, глобальний фільтр |
| `src/problem/problem.filter.ts` | Глобальний exception-filter → `application/problem+json`       |
| `src/problem/problem.util.ts`   | Конструктор тіла `Problem` (RFC 9457)                          |
| `src/common/pagination.ts`      | Cursor: encode/decode непрозорого токена + `paginate`          |
| `src/products/*`                | Модуль/контролер/сервіс товарів (Postgres)                     |
| `src/orders/*`                  | Модуль/контролер/сервіс замовлень + ідемпотентність (in-memory) |
| `src/config/env.schema.ts`      | zod-схема env + `validate` (fail-fast на старті)               |
| `src/db/database.service.ts`    | `pg.Pool`, пароль — функція, що перечитує файл-секрет           |
| `src/health/*`                  | `GET /health`: uptime, pid, стан БД, лічильники пулу           |
| `scripts/check-env-example.mjs` | Звірка `.env.example` зі схемою (`npm run check:env`)          |
| `.env.example`                  | Контракт змінних у git; реальний `.env` — у `.gitignore`       |
| `secrets/db_password`           | Файл-секрет із паролем БД (у `.gitignore` і `.dockerignore`)   |
| `rotate.sh`                     | Ротація пароля БД без рестарту сервісу                          |
| `docker-compose.yml`            | Локальний Postgres (стенд для розробки, ротації та ДЗ-12)      |
| `db/schema.sql`                 | Таблиці, констрейнти, генерована `tsvector`-колонка            |
| `db/seed.sql`                   | Генерація даних (≥100 000 рядків) + `VACUUM (ANALYZE)`         |
| `db/queries/q1..q4.sql`         | Реальні запити API — по одному statement на файл                |
| `db/indexes.sql`                | Усі індекси оптимізації, включно з GIN під q4                   |
| `db/explain.sh`                 | Прогін `EXPLAIN (ANALYZE, BUFFERS)` для q1..q4                  |
| `db/OPTIMIZATIONS.md`           | 4 пари `EXPLAIN` до/після + секція «Морфологія»                 |
| `Dockerfile`, `.dockerignore`   | Образ без секретів у шарах                                     |
| `README.md`                     | Цей файл                                                       |

### Чому саме так у `main.ts`

`bodyParser: false` при створенні застосунку + власний `express.json()` **перед** валідатором
гарантують порядок middleware `json → express-openapi-validator → Nest-роути`. Помилки валідатора
Nest пропускає у свій exception-layer, тож їх (разом із `404`/`422` із сервісів) ловить один
`ProblemJsonFilter` і віддає `problem+json`.

## Configuration

Конфігурація тече одним напрямком, без «зручних» обходів:

```
process.env ──▶ zod-схема (fail-fast) ──▶ ConfigService<Env, true> ──▶ код
secrets/db_password ──▶ password: () => readFile() ──▶ pg.Pool ──▶ Postgres
```

Прямих читань `process.env` поза `src/config/env.schema.ts` у коді немає. Зламана
змінна вбиває процес **на старті** зі зрозумілою помилкою, а не на першому запиті в проді:
`validate` у `ConfigModule.forRoot` викликається ДО побудови DI-графа й кидає один `Error`
зі списком **усіх** проблемних змінних одразу.

Пароль БД у цей потік свідомо не входить: він живе у файлі-секреті й читається
функцією на кожне нове зʼєднання — тому його можна ротувати без рестарту сервісу.

### Змінні середовища

Джерело правди — `src/config/env.schema.ts`. Контракт у git — `.env.example`
(реальний `.env` у `.gitignore`). Синхронність звіряє `npm run check:env`.

| Змінна | Тип / значення | Обовʼязкова | Типово | Джерело значення | Призначення |
| --- | --- | --- | --- | --- | --- |
| `NODE_ENV` | `development` \| `test` \| `production` | ні | `development` | оточення процесу | Режим роботи застосунку |
| `PORT` | integer 1..65535 | ні | `3000` | оточення процесу | HTTP-порт |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` | ні | `info` | оточення процесу | Рівень логування |
| `DB_URL` | `postgres://<user>@<host>:<port>/<db>` | **так** | — | **сховище секретів** (оточення `dev` і `prod`); локально — `.env`, не в git | DSN Postgres бази цього проєкту, **без пароля** |
| `DB_PASSWORD_FILE` | шлях | ні | `./secrets/db_password` | оточення процесу (шлях — не секрет) | Файл-секрет із паролем БД: сам пароль приходить зі **сховища** через змонтований файл |
| `DB_POOL_MAX` | integer 1..100 | ні | `10` | оточення процесу | Максимум зʼєднань у пулі |
| `DB_CONNECTION_TIMEOUT_MS` | integer 100..60000 | ні | `5000` | оточення процесу | Таймаут отримання зʼєднання |
| `DB_SSL` | `true` \| `false` | ні | `false` | оточення процесу | TLS до Postgres |
| `VALIDATE_RESPONSES` | `true` \| `false` | ні | `true` | оточення процесу | Валідація відповідей проти OpenAPI |
| `DEFAULT_CURRENCY` | ISO 4217, 3 символи | ні | `UAH` | оточення процесу | Валюта замовлення за замовчуванням |
| `DEFAULT_PAGE_LIMIT` | integer 1..100 | ні | `20` | оточення процесу | Розмір сторінки cursor-пагінації |

Рядок підключення до БД (`DB_URL`) і пароль до неї — єдині секрети застосунку, і жоден із них
не лежить у git: у репозиторії є лише `.env.example` із фейковими значеннями. Локально
`DB_URL` береться з `.env` (у `.gitignore`), у `dev` і `prod` — зі сховища секретів, а пароль
приходить окремо, файлом, змонтованим у `DB_PASSWORD_FILE` (docker secret / k8s secret), і
перечитується на кожне нове зʼєднання — див. [Ротацію](#ротація-пароля-бд-без-рестарту).
Дев-креденшели самого контейнера Postgres — інша річ: вони не секрет і лежать відкрито в
`docker-compose.yml` та `secrets/db_password.example`, щоб базу можна було підняти зі свіжого
клону.

Числа описані через `z.coerce.number()`, а не `z.number()`: усе, що приходить з env, —
рядок. Булеві значення — через явний `z.enum([...]).transform(...)`, бо
`z.coerce.boolean()` перетворив би рядок `"false"` на `true`.

`DB_URL` не містить пароля навмисно: схема відхилить DSN із паролем усередині.

### Запуск

```bash
npm install
cp .env.example .env          # реальні значення; .env у .gitignore
npm run db:up                 # secrets/db_password з .example + Postgres у docker compose
npm run db:schema             # таблиці (db/schema.sql)
npm run db:seed               # дані: 120k товарів, 200k замовлень (~17 с)
npm start                     # build + node dist/main.js -> http://localhost:3000

curl -s localhost:3000/health
curl -s localhost:3000/products
```

`npm start` свідомо **не** watch-режим: `nest start --watch` не завершується й не віддає
exit code, тож на ньому неможливо перевірити fail-fast. Для розробки — `npm run start:dev`.

Перевірити конфіг без запуску застосунку:

```bash
npm run check:env             # .env.example звірено зі схемою; exit 1, якщо відстав
```

### Секрети

| Де | Що з ним |
| --- | --- |
| git | `.env` та `secrets/*` у `.gitignore`; у репозиторії лише `.env.example` з фейковими значеннями |
| docker-образ | `.env`, `secrets/` — у `.dockerignore`; в образі немає ані файлів, ані `ENV` з паролем |
| рантайм | пароль приходить із примонтованого файла (docker secret / volume / k8s secret) |

```bash
git check-ignore .env                     # -> .env
git ls-files | grep -c '\.env$'           # -> 0
docker build -t myapp .
docker run --rm myapp ls -a /app          # є .env.example, немає .env і secrets/
docker inspect --format '{{.Config.Env}}' myapp   # лише PATH, NODE_VERSION, YARN_VERSION
```

### Ротація пароля БД без рестарту

Чому це працює: у `src/db/database.service.ts` полю `password` пула `pg` передано **функцію**,
а не рядок. `pg` викликає її на кожне нове зʼєднання — тож достатньо змінити пароль у БД,
переписати файл і закрити старі зʼєднання. Процес не перезапускається, `uptime` не обнуляється.

Обовʼязкова деталь: `pool.on('error', ...)`. Після `pg_terminate_backend` пул емітить `error`
на простій-зʼєднаннях, і **без обробника процес упаде** — це не баг ротації, а відсутній
обробник.

Покроково:

```bash
# 1. Запамʼятати uptime до ротації
curl -s localhost:3000/health | jq '{uptime_seconds, pid, db}'

# 2. Ротація: ALTER ROLE -> файл-секрет -> pg_terminate_backend
bash rotate.sh                 # або: bash rotate.sh 'своїйНовийПароль'

# 3. Запит, що ходить у БД, далі віддає 200
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/products

# 4. uptime БІЛЬШИЙ за попередній, pid той самий -> рестарту не було
curl -s localhost:3000/health | jq '{uptime_seconds, pid, db}'
```

Що робить `rotate.sh` і чому саме в такому порядку:

1. `ALTER ROLE marketplace WITH PASSWORD '<new>'` — новий пароль стає дійсним у БД;
2. атомарний запис `secrets/db_password` (через `.tmp` + `mv`) — застосунок дізнається про нього;
3. `pg_terminate_backend(...)` — старі зʼєднання закриваються, пул піднімає нові вже з новим паролем.

Між кроками 1 і 2 існує вікно в кілька мілісекунд, коли нове зʼєднання спробувало б старий
пароль. Промислове рішення цієї гонки — **alternating users**: дві ролі, які ротуються по
черзі (AWS Secrets Manager rotation strategies). Для навчального завдання вікно приймаємо.

### Граблі, на які легко наступити

- `docker compose down -v` видаляє том Postgres. Щоб після цього не отримати
  `password authentication failed`, БД бере стартовий пароль з того самого файла
  (`POSTGRES_PASSWORD_FILE: /run/secrets/db_password`), а не з хардкоду в SQL. Після скидання
  тому таблиць немає — схему й дані треба залити знову (`npm run db:schema && npm run db:seed`).
- `npm start` має бути не-watch, інакше перевірка fail-fast механічно не проходить.
- Для перевірки fail-fast треба тимчасово прибрати `.env` — інакше `dotenv` тихо підхопить
  змінну з файла: `mv .env /tmp && env -u DB_URL npm start; echo $?; mv /tmp/.env .`
- TypeScript + `pg` потребують `@types/pg` у devDependencies, інакше `tsc` падає з TS7016.
- Схема НЕ підключена до `docker-entrypoint-initdb.d`: інакше `psql -f db/schema.sql` падав би
  на вже створених таблицях.

## Дата-шар (ДЗ-12)

Схема, seed на реальний обсяг, чотири повільні запити та індекси, що їх лікують.
Повний звіт із планами `EXPLAIN (ANALYZE, BUFFERS)` до і після — у
[`db/OPTIMIZATIONS.md`](db/OPTIMIZATIONS.md).

| | Таблиця | Рядків у seed |
| --- | --- | --- |
| **головна таблиця** | `orders` | 200 000 |
| **таблиця, по якій шукає q4** | `products` | 120 000 |
| | `users` | 50 000 |
| | `order_items` | ~400 000 |

### Підняти базу

```bash
[ -f secrets/db_password ] || cp secrets/db_password.example secrets/db_password && docker compose up -d --wait
```

Один рядок, працює на свіжому клоні без правок файлів. `secrets/db_password` у
`.gitignore`, тому в репозиторії лежить `secrets/db_password.example` із дев-значенням —
з нього ж бере пароль і Postgres у `docker-compose.yml`. Еквівалент через npm: `npm run db:up`.

### Підключитись

```bash
docker compose exec -T db psql -U marketplace -d marketplace
```

Перевірка одним рядком: `docker compose exec -T db psql -U marketplace -d marketplace -Atc "SELECT 1"` → `1`.

### Повний цикл

Порядок важливий — саме в такому база проходить від нуля до індексних планів:

```bash
docker compose down -v && cp secrets/db_password.example secrets/db_password && docker compose up -d --wait

docker compose exec -T db psql -U marketplace -d marketplace -v ON_ERROR_STOP=1 < db/schema.sql
docker compose exec -T db psql -U marketplace -d marketplace -v ON_ERROR_STOP=1 < db/seed.sql

RUNS=1 bash db/explain.sh          # EXPLAIN ДО індексів — у кожному плані є Seq Scan

docker compose exec -T db psql -U marketplace -d marketplace -v ON_ERROR_STOP=1 < db/indexes.sql
docker compose exec -T db psql -U marketplace -d marketplace -c "ANALYZE"

bash db/explain.sh                 # EXPLAIN ПІСЛЯ — індексні плани, Seq Scan немає
```

Ті самі кроки як npm-скрипти: `npm run db:reset`, `db:schema`, `db:seed`, `db:indexes`, `db:explain`.

У першому рядку `cp` без перевірки — навмисно: `down -v` видаляє том, і піднятий заново
Postgres візьме стартовий пароль знову з `secrets/db_password.example`. Якщо не перезаписати
файл, після ротації пароля (ДЗ-11) застосунок стукав би ротованим паролем у свіжу базу зі
стартовим — те саме `password authentication failed`, про яке попереджає умова.

`db/seed.sql` займає ~17 секунд і закінчується `VACUUM (ANALYZE)`, а не просто `ANALYZE`:
статистику для планера дає `ANALYZE`, але visibility map виставляє лише `VACUUM` — без неї
плани «після» лізуть у heap за видимістю й показують у рази гірші buffers.

`db/explain.sh` проганяє кожен запит тричі й друкує останній прогін: перший виклик q4 після
`CREATE INDEX` може піти по холодному GIN і показати час у рази гірший за справжній. На стенді з
великим `shared_buffers` різниці може й не бути — але правило «взяти останній прогін» дешевше,
ніж розбиратися, чому число не сходиться.

### Запити й індекси

| Запит | Що це в API | Індекс | Тип |
| --- | --- | --- | --- |
| [`db/queries/q1.sql`](db/queries/q1.sql) | замовлення покупця за період | `idx_orders_buyer_created_at` | складений B-tree |
| [`db/queries/q2.sql`](db/queries/q2.sql) | черга необроблених замовлень | `idx_orders_pending_created_at` | **partial** |
| [`db/queries/q3.sql`](db/queries/q3.sql) | пошук користувача за email без урахування регістру | `idx_users_lower_email` | **expression**, UNIQUE |
| [`db/queries/q4.sql`](db/queries/q4.sql) | повнотекстовий пошук по каталогу | `idx_products_search_vector` | **GIN по tsvector** |

Чотири індекси на чотири запити, жодного «про запас» — кожен доведено використаним
(`idx_scan > 0` у `pg_stat_user_indexes`). Пошуковий вектор — генерована збережена колонка
`products.search_vector`, Postgres перераховує її сам на кожному `INSERT`/`UPDATE`.

Український пошук працює лише на точній словоформі: `simple` не має стемера, а української
конфігурації в Postgres немає взагалі (29 конфігурацій, жодної української). Числа й причина —
у секції [«Морфологія»](db/OPTIMIZATIONS.md#морфологія) звіту.

### Що далі

`orders`/`order_items` у схемі вже є й наповнені, але `GET /orders` у застосунку поки лишається
in-memory: перевести його в БД — робота ДЗ-14 разом із транзакціями. ДЗ-13 бере цю саму схему в
TypeORM-entities та міграції.

## Що в спеці

- **Ресурси:** `/products`, `/orders`.
- **Операції (5):** `listProducts`, `getProductById`, `listOrders`, `createOrder`, `getOrderById`.
- **Cursor-пагінація** на `GET /products` і `GET /orders`: query `limit` і `cursor`
  (непрозорий токен), відповідь `{ items, next_cursor }`, `next_cursor` — `nullable`
  (`null` = сторінок більше немає).
- **Idempotency-Key** — header на `POST /orders`, `required: true`; семантику повтору описано
  в `description` параметра.
- **problem+json** — кожна 4xx/5xx має `content: application/problem+json` зі схемою `Problem`
  (`type`/`title`/`status`/`detail`/`instance`).
- **Гроші** — цілі копійки (`price_cents`, `total_cents`: `integer`), без float.
- `security: []` на корені — авторизації в API поки свідомо немає (закриває redocly-правило
  `security-defined`).

## Перевірки (acceptance criteria)

Усі команди працюють одразу після `npm install`, без ручних кроків.

### 1. Спека валідна — `exit 0`

```bash
npx @redocly/cli lint openapi/openapi.yaml
# Woohoo! ... 1 warning (localhost server) — warnings дозволені, errors немає.
```

### 2. Обсяг спеки — операцій ≥ 5, ресурсів ≥ 2, Idempotency-Key required + опис ≥ 40

```bash
npx @redocly/cli bundle openapi/openapi.yaml -o spec.json
node -e "const s=require('./spec.json'),M=['get','post','put','patch','delete'];\
const ops=Object.entries(s.paths).flatMap(([p,v])=>Object.keys(v).filter(m=>M.includes(m)).map(m=>[p,m]));\
const idem=ops.flatMap(([p,m])=>s.paths[p][m].parameters??[]).find(x=>x.in==='header'&&/idempotency-key/i.test(x.name));\
console.log('операцій:',ops.length,'· ресурсів:',new Set(Object.keys(s.paths).map(p=>p.split('/')[1])).size);\
console.log('Idempotency-Key: required =',idem?.required,'· опис, символів =',(idem?.description??'').trim().length)"
# очікуємо: операцій: 5 · ресурсів: 2 · required = true · опис, символів = 297
```

### 3–5. grep-перевірки

```bash
grep -c 'Idempotency-Key' openapi/openapi.yaml          # >= 1
grep -c 'next_cursor' openapi/openapi.yaml               # >= 1
grep -c 'application/problem+json' openapi/openapi.yaml   # >= 2
```

### 6. Contract-частина працює — Variant Б

Спочатку `npm start` в іншому терміналі, далі:

```bash
# 6.1 БЕЗ Idempotency-Key -> 400 + application/problem+json
curl -i -X POST http://localhost:3000/orders \
  -H 'Content-Type: application/json' \
  -d '{"items":[{"product_id":"p_1","quantity":1}]}'
# detail: request/headers must have required property 'idempotency-key'

# 6.2 Порожній items -> 400 (деталь від валідатора)
curl -i -X POST http://localhost:3000/orders \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: k-1' \
  -d '{"items":[]}'
# detail: request/body/items must NOT have fewer than 1 items

# 6.3 Валідний запит -> 201
curl -i -X POST http://localhost:3000/orders \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: k-abc' \
  -d '{"items":[{"product_id":"p_1","quantity":2},{"product_id":"p_2","quantity":1}]}'
# 201, total_cents: 6100 (2600*2 + 900*1)
```

## Додатковий виклик (повна семантика ключа)

```bash
# той самий ключ + те саме тіло -> 201 + заголовок Idempotency-Replay: true
curl -i -X POST http://localhost:3000/orders \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: k-abc' \
  -d '{"items":[{"product_id":"p_1","quantity":2},{"product_id":"p_2","quantity":1}]}'
# 201, Idempotency-Replay: true, те саме замовлення

# той самий ключ + ІНШЕ тіло -> 422 problem+json
curl -i -X POST http://localhost:3000/orders \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: k-abc' \
  -d '{"items":[{"product_id":"p_3","quantity":9}]}'
# 422, detail: Idempotency-Key was already used with a different request body
```

## Демонстрація `validateResponses: true` (runtime-аналог DRIFT-чека)

Якщо хендлер віддасть відповідь, що суперечить спеці (напр. `totalCents` замість
`total_cents`), валідатор відповіді відхилить її:

```
500 application/problem+json
detail: /response must have required property 'total_cents'
```

Тобто «сервер сам не віддасть зайвого/іншого» гарантує `validateResponses`, а не `if` у коді.

## Приклад cursor-пагінації

```bash
curl -s 'http://localhost:3000/products?limit=2'
# {"items":[...2...],"next_cursor":"eyJvIjoyfQ"}   (opaque токен)
curl -s 'http://localhost:3000/products?limit=2&cursor=eyJvIjoyfQ'
# {"items":[...],"next_cursor":null}               (сторінок більше немає)
```
