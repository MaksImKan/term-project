# Marketplace API — курсовий проєкт

NestJS + `express-openapi-validator` (ДЗ-09), керована конфігурація з ротацією
секретів (ДЗ-11), дата-шар на Postgres з індексами та повнотекстовим пошуком (ДЗ-12)
TypeORM поверх цієї схеми — entities, міграції, N+1 (ДЗ-13) — і конкурентні
транзакції: checkout без oversell, воркер-пул на `SKIP LOCKED`, retry (ДЗ-14).
Операційний шар бази — PgBouncer перед Postgres, нічний бекап і restore-drill (ДЗ-15).
Тести — integration на testcontainers, E2E через supertest і контрактні тести на Pact
із гейтом `can-i-deploy` у CI (ДЗ-16).
Realtime — нотифікації про статус замовлення двома транспортами: WebSocket-кімнати
з перевіркою власника і SSE з відновленням після обриву (ДЗ-18).
Асинхронний канал — RabbitMQ: подія order.placed із бізнес-операції, ручний ack,
DLQ з читабельною причиною та ідемпотентний споживач (ДЗ-19).
Transactional outbox закриває вікно між COMMIT і публікацією: подія пишеться в ту
саму транзакцію, виносить її relay, а дубль гасить ідемпотентність (ДЗ-22).
Redis у чотирьох ролях — кеш із джитером TTL і single-flight локом, сесії з rolling
TTL, спільний на поди rate-limit і черга BullMQ (ДЗ-23).

* [Grading](#grading) — блок для грейдера: свіжий клон, чиста БД, без сховища
* [Configuration](#configuration) — змінні середовища, запуск, ротація пароля БД
* [Дата-шар](#дата-шар-дз-12) — схема, seed на 100k+, `EXPLAIN` до і після індексів
* [ORM-шар](#orm-шар-дз-13) — entities, міграції, N+1, Repository проти QueryBuilder
* [Конкурентність](#конкурентність-дз-14) — транзакційний checkout, SKIP LOCKED, retry
* [Data layer ops](#data-layer-ops-дз-15) — PgBouncer, бекап, restore-drill
* [Тестування](#тестування-дз-16) — testcontainers, ізоляція, E2E, Pact і гейт can-i-deploy
* [Realtime](#realtime-websocket--sse-дз-18) — WS-кімнати з перевіркою власника, SSE з Last-Event-ID
* [Trade-offs](#trade-offs-websocket-vs-sse) — WebSocket проти SSE і що я лишив би в проді
* [Async-події](#async-події-через-rabbitmq-дз-19) — RabbitMQ, ручний ack, DLQ, ідемпотентний споживач
* [Outbox](#outbox-та-ідемпотентність-дз-22) — один COMMIT на запис і подію, relay, три рівні ідемпотентності
* [Redis](#redis-кеш-сесії-ліміти-черга-дз-23) — кеш із джитером і локом, сесії, ліміт, черга BullMQ

## Grading

Блок для грейдера: свіжий клон, чиста БД, без доступу до сховища секретів.
Працює як є, без правок файлів.

```bash
docker compose up -d --wait
# 6432 — це PgBouncer (сервіс pgbouncer), а не прямий порт Postgres
export DATABASE_URL=postgres://marketplace:dev_password_0@127.0.0.1:6432/marketplace
export SKIP_VAULT=1    # у грейдера немає доступу до сховища

npm ci
npx tsc --noEmit                  # компіляція чиста
npm run build
npm run migrate                   # схема з нуля
npm run migrate:show              # всі міграції [X]
npm run migrate:revert            # down() реально відкочує
npm run migrate                   # і повертається назад
npm run seed && npm run seed      # ідемпотентно

npm run demo:nplus1               # ДЗ-13: запитів «до» і «після»
npm run report                    # ДЗ-13: агрегат через QueryBuilder

npm run demo:race                 # ДЗ-14: 50 паралельних checkout, oversell = 0
npm run demo:workers              # ДЗ-14: воркер-пул на SKIP LOCKED
npm run demo:retry                # ДЗ-14: serialization failure + повтор

# ДЗ-15: пулер, бекап, restore-drill
psql -h 127.0.0.1 -p 6432 -U marketplace -d marketplace -c "SELECT 1"
PGPASSWORD=dev_admin_0 psql -h 127.0.0.1 -p 6432 -U pgbouncer_admin -d pgbouncer -c "SHOW POOLS"
bash scripts/with-secrets.sh dev bash scripts/backup.sh
bash scripts/with-secrets.sh dev bash scripts/restore-drill.sh

# ДЗ-16: тести. Базу підіймають самі (testcontainers), сховище їм не потрібне.
npm run test:integration          # 18 тестів, справжній Postgres (+ outbox ДЗ-22)
npm run test:e2e                  # 8 тестів, повний застосунок через HTTP (+ realtime ДЗ-18)
npm run test:contract             # 2 тести -> pacts/marketplace-web-marketplace-api.json
npm run verify:provider           # застосунок проти цього контракту

# ДЗ-16: брокер і гейт can-i-deploy — обидва стани, до тегу prod і після
npm run pact:gate

# ДЗ-18: realtime. Потрібен піднятий застосунок — npm start в іншому терміналі.
curl -sN --max-time 2 -D - -o /dev/null http://localhost:3000/orders/o_1/events \
  | grep -i '^content-type'                 # text/event-stream
curl -s -X PATCH http://localhost:3000/orders/o_1/status \
  -H 'Content-Type: application/json' -d '{"status":"paid"}'
curl -sN --max-time 2 -H 'Last-Event-ID: 3' http://localhost:3000/orders/o_1/events \
  | grep '^id:' | head -1                   # id > 3 після 4+ змін статусу
node scripts/realtime-demo.mjs;             echo "exit=$?"   # A=1 B=0
node scripts/realtime-demo.mjs --same-room; echo "exit=$?"   # A=1 B=1

# ДЗ-19: асинхронні події через RabbitMQ.
# Порт 5672 — це AMQP; 15672 — вебморда менеджменту, протоколом вона не відповідає.
export BROKER_URL=amqp://app:app@127.0.0.1:5672
npm run demo:publish              # published=5 effect=5 dlq=0 prefetch=10
npm run demo:dlq                  # work=0 dlq=1 dlq-reason=rejected
npm run demo:duplicate            # deliveries=2 effect=1

# ДЗ-22: transactional outbox і три рівні ідемпотентності.
npm run demo:outbox               # requests=2 orders=1 outbox=1 published=1 effect=1 processed=1
npm run demo:crash-write          # write-failed=1 orders=0 outbox=0 published=0 deliveries=0 effect=0
npm run demo:crash-relay          # deliveries=2 applied=1 effect=1 processed=1

# ДЗ-23: Redis. Два інстанси — кеш і черга, політики несумісні в одному процесі.
export REDIS_URL=redis://127.0.0.1:6390        # кеш: maxmemory + allkeys-lru
export REDIS_QUEUE_URL=redis://127.0.0.1:6391  # черга і сесії: noeviction + AOF
npm run demo:cache                # db-calls=1 db-calls-warm=0 ttl-distinct>=5
npm run demo:session              # sessions=1 in-redis=1 ttl-renewed=1
npm run demo:ratelimit            # instances=2 allowed=limit status=429 retry-after=1
npm run demo:queue                # attempts=3 completed=1 added=2 queued=1
```

Демо ДЗ-19 потребують `npm run migrate && npm run seed` вище: подія виходить із
справжнього `checkout`, а ефект споживача лягає в таблицю `picking_tasks`.
`SKIP_VAULT=1` уже експортовано на початку блоку — три демо-скрипти ходять у
брокер через ту саму обгортку сховища, що й `migrate`.

`verify:provider` читає контракт, який створює `test:contract` (`pacts/` — у
`.gitignore`, це згенерований артефакт), тому порядок саме такий. Усе інше
порядку не має.

Пароль для `psql` вище — `dev_password_0` (той самий, що в `DATABASE_URL`);
`PGPASSWORD=dev_password_0` або введений у промпті.

`backup.sh` і `restore-drill.sh` читають підключення з `$DATABASE_URL` самі, тому
під `SKIP_VAULT=1` обгортка просто виконує їх як є — обидві форми запуску
(`bash scripts/with-secrets.sh dev bash scripts/backup.sh` і голий
`bash scripts/backup.sh`) дають однаковий результат. `pg_dump` при цьому свідомо
йде напряму в `:5432`, в обхід пулера, і друкує це в лозі — чому саме так,
у розділі [Data layer ops](#data-layer-ops-дз-15).

`package.json` лежить у корені репозиторію, тому жодного `cd` перед цими
командами не потрібно.

Замість єдиного `DATABASE_URL` можна експортувати розібрані змінні — `data-source.ts`
розуміє обидві форми:

```bash
export DB_HOST=127.0.0.1 DB_PORT=6432 DB_USER=marketplace DB_PASSWORD=dev_password_0 DB_NAME=marketplace
```

Креденшели вище — дев-значення стенда з `docker-compose.yml`; вони не секрет і
лежать у репозиторії відкрито саме для цього. `SKIP_VAULT=1` вимикає звернення
до сховища всередині `scripts/with-secrets.sh` — значення вже в оточенні.
Основний шлях (`infisical run`) при цьому лишається на місці й описаний нижче.

Перевірка кількості рядків після другого `npm run seed` — числа не змінюються:

```bash
docker compose exec -T db psql -U marketplace -d marketplace -Atc \
  "SELECT (SELECT count(*) FROM users)||' users, '||
          (SELECT count(*) FROM products)||' products, '||
          (SELECT count(*) FROM orders)||' orders, '||
          (SELECT count(*) FROM order_items)||' items'"
# 6 users, 10 products, 8 orders, 18 items
```

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
| `src/entities/*`                | TypeORM-сутності схеми (ДЗ-13)                                  |
| `src/migrations/*`              | Міграції; `synchronize` вимкнено                                |
| `src/data-source.ts`            | `DataSource`: креденшели лише з `process.env`                   |
| `src/seed.ts`                   | Детермінований ідемпотентний seed                               |
| `src/demo-nplus1.ts`            | N+1 «до/після» з лічильником SQL-запитів                        |
| `src/report.ts`                 | Звіт через `createQueryBuilder().getRawMany()`                  |
| `scripts/with-secrets.sh`       | Обгортка сховища секретів (`SKIP_VAULT=1` для CI/грейдера)      |
| `src/checkout.ts`               | Транзакційний checkout: stock + баланс + замовлення + задача    |
| `src/retry.ts`                  | Повтор транзакції на 40001 / 40P01 із backoff                   |
| `src/demo-race.ts`              | 50 паралельних checkout-ів: перевірка на oversell               |
| `src/demo-workers.ts`           | Воркер-пул через `FOR UPDATE SKIP LOCKED`                       |
| `src/demo-retry.ts`             | Serialization failure «до/після» retry                          |
| `pgbouncer/*`                   | Конфіг PgBouncer: `pool_mode = transaction`, userlist           |
| `scripts/backup.sh`             | `pg_dump -Fc` із датою в імені + контрольне значення            |
| `scripts/restore-drill.sh`      | Відновлення у чистий контейнер, порівняння «до/після»           |
| `backup.cron`                   | Нічний розклад бекапу                                           |
| `RESTORE-DRILL.md`              | Протокол drill-у: розмір, час, RTO, RPO                         |
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
docker compose down -v && docker compose up -d --wait

docker compose exec -T db psql -U marketplace -d marketplace -v ON_ERROR_STOP=1 < db/schema.sql
docker compose exec -T db psql -U marketplace -d marketplace -v ON_ERROR_STOP=1 < db/seed.sql

RUNS=1 bash db/explain.sh          # EXPLAIN ДО індексів — у кожному плані є Seq Scan

docker compose exec -T db psql -U marketplace -d marketplace -v ON_ERROR_STOP=1 < db/indexes.sql
docker compose exec -T db psql -U marketplace -d marketplace -c "ANALYZE"

bash db/explain.sh                 # EXPLAIN ПІСЛЯ — індексні плани, Seq Scan немає
```

Ті самі кроки як npm-скрипти: `npm run db:reset`, `db:schema`, `db:seed`, `db:indexes`, `db:explain`.

`down -v` видаляє том, і піднятий заново Postgres знову візьме стартовий пароль із
`secrets/db_password.example`. Якщо до того була ротація (ДЗ-11), власний файл застосунку
лишиться з ротованим паролем — поверни його командою
`cp secrets/db_password.example secrets/db_password`, інакше отримаєш
`password authentication failed` при цілком робочій базі.

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

## ORM-шар (ДЗ-13)

Схема з ДЗ-12 переїхала в код: entities + relations + міграції. `synchronize`
вимкнено явно — єдиний спосіб змінити структуру це міграція, яку видно в
code review і яку можна відкотити.

| Файл | Призначення |
| --- | --- |
| [`src/entities/`](src/entities/) | чотири сутності схеми: `User`, `Product`, `Order`, `OrderItem` |
| [`src/data-source.ts`](src/data-source.ts) | `DataSource` із `synchronize: false`; креденшели лише з `process.env` |
| [`src/migrations/`](src/migrations/) | початкова схема; згенерована, потім поправлена руками |
| [`src/seed.ts`](src/seed.ts) | детермінований ідемпотентний seed |
| [`src/demo-nplus1.ts`](src/demo-nplus1.ts) | N+1 «до/після» з лічильником SQL-запитів |
| [`src/report.ts`](src/report.ts) | агрегат через `createQueryBuilder().getRawMany()` |
| [`scripts/with-secrets.sh`](scripts/with-secrets.sh) | обгортка сховища; усередині неї запускаються всі команди, що ходять у базу |

### Команди

```bash
docker compose up -d --wait
npm run build
npm run migrate          # усередині: bash scripts/with-secrets.sh dev npx typeorm migration:run
npm run migrate:show
npm run seed
npm run demo:nplus1
npm run report
```

Кожна з них загорнута в `scripts/with-secrets.sh dev …`: параметри підключення
приходять зі сховища, а не з env-файла в репозиторії. Без доступу до сховища —
`SKIP_VAULT=1` і значення в оточенні (див. [Grading](#grading)).

CLI міграцій працює зі **скомпільованим** DataSource (`-d dist/data-source.js`),
тому `npm run build` обовʼязковий перед `npm run migrate`. Згенерувати нову
міграцію після зміни entity: `npm run migration:generate -- src/migrations/Name`,
потім знову `npm run build` — згенерований `.ts` теж треба скомпілювати.

### Relations і onDelete

M:N між замовленням і товаром виражений **явною join-entity** `OrderItem`, а не
`@ManyToMany`: на звʼязку висять дані — кількість і ціна на момент купівлі.
`@ManyToMany` створив би службову таблицю з двох колонок, куди ці поля нікуди
покласти. Правило: є дані на звʼязку — є окрема сутність.

| Звʼязок | onDelete | Чому саме так |
| --- | --- | --- |
| `Product.seller → User` | `RESTRICT` | продавця з товарами не видалити: на товари посилається історія покупок |
| `Order.buyer → User` | `RESTRICT` | замовлення це фінансовий документ, він переживає обліковий запис |
| `OrderItem.order → Order` | **`CASCADE`** | єдиний звʼязок, де дитина справді належить батькові: немає замовлення — немає його рядків |
| `OrderItem.product → Product` | `RESTRICT` | товар НЕ володіє позицією; видалити куплений товар означає зламати суму замовлення |

`@OneToOne` у схемі немає: жодна пара таблиць не звʼязана один-до-одного.
Додавати його штучно, щоб «було», означало б завести таблицю, якої домен не
потребує.

### N+1: до і після

`npm run demo:nplus1` бере реальний запит екрана «мої замовлення» —
граф на два рівні `order → items → product` — і рахує SQL-запити власним
`Logger` при `logging: ['query']`.

| Стратегія | N = 4 | N = 8 | Залежить від N? |
| --- | --- | --- | --- |
| наївно (запит у циклі) | **13** | **27** | так: `1 + N + позиції` |
| `relations` (join) | 2 | 2 | ні |
| `leftJoinAndSelect` | 2 | 2 | ні |
| `relationLoadStrategy: 'query'` | 4 | 4 | ні |
| `relations` без пагінації | — | **1** | ні |

Наївний варіант росте разом із колекцією: 13 запитів на 4 замовлення (8 позицій)
і 27 на 8 (18 позицій). Усі виправлені — константа, і при подвоєнні вибірки
число не змінюється.

Числа зняті на чистому сіді (8 замовлень). Якщо перед цим ганяли
[`demo:race`](#конкурентність-дз-14), у базі лишаться ще й його замовлення — N
стане більшим, «наївно» зросте пропорційно, а константність «після» від цього не
зміниться (у цьому й перевірка).

Чому join з пагінацією дає 2, а не 1: із `take` TypeORM спершу окремим запитом
вибирає N різних id кореневої сутності. Інакше `LIMIT` обрізав би рядки **після**
join-у, тобто позиції, а не замовлення — і сторінка з 4 замовлень виявилась би
сторінкою з 4 позицій. Без пагінації той самий граф тягнеться рівно за 1 запит.
Обидва числа константні, тобто це не N+1.

`relationLoadStrategy: 'query'` дає 4 = `1 (id кореня) + 1 (кореневі рядки) +
1 (позиції) + 1 (товари)`: запит на РІВЕНЬ, а не на рядок. Він виграє там, де
join розмножує дані (широкі рядки × багато позицій), і програє на дрібних графах
зайвими round-trip-ами.

### Repository чи QueryBuilder

Межу проводжу по тому, **що саме повертає запит**. Якщо результат — сутність або
граф сутностей у тому вигляді, в якому їх розуміє домен (`find`, `findOne`,
`relations`), беру Repository: типи виводяться самі, звʼязки збираються в обʼєкти,
код читається як опис наміру. Якщо результат — не сутність, а форма звіту
(агрегати, `GROUP BY`, join трьох таблиць у один рядок із полями, яких немає в
жодній із них), беру `createQueryBuilder().getRawMany()` — `find()` це просто не
вміє, а спроба зімітувати його через завантаження сутностей у памʼять і
згортання в JS і є класичний спосіб привезти пів бази в застосунок.
`npm run report` — саме такий випадок: виторг по продавцях через три `innerJoin`,
`SUM`, `COUNT(DISTINCT …)` і `GROUP BY`.

Окрема дрібниця, яка ловить: агрегати приходять **рядками**, а не числами —
`COUNT`/`SUM` у Postgres це `bigint`/`numeric`, і драйвер не ризикує точністю,
бо `bigint` не завжди влазить у `number`. Конвертуємо явно.

### Seed

`src/seed.ts` — детермінований і ідемпотентний: 6 користувачів, 10 товарів,
8 замовлень, 18 позицій; однакові дані на кожному запуску.

```bash
npm run seed && npm run seed    # без помилок, кількість рядків не змінюється
```

Механіка ідемпотентності: всі id задані явно, а `repository.save()` із наявним
первинним ключем робить `UPDATE`, а не `INSERT`. Саме заради цього ключі
оголошені як `GENERATED BY DEFAULT AS IDENTITY`, а не `ALWAYS` — під `ALWAYS`
Postgres відмовився б приймати явний id. Наприкінці seed синхронізує
послідовності (`setval`): явні id не рухають лічильник IDENTITY, і перша ж
автоматична вставка після seed впала б на дублікаті ключа.

Дати теж фіксовані, тому `created_at` оголошено звичайною колонкою з
`DEFAULT now()`, а не `@CreateDateColumn`: той завжди перезаписує значення
поточним часом, а в `orders` від дати залежить CHECK `paid_at >= created_at`.

### Чого ORM не вміє

Три індекси з ДЗ-12 декораторами не виражаються, тому у міграції вони дописані
руками — і це найпредметніша ілюстрація ціни ORM у цьому проєкті:

| Індекс | Чого бракує `@Index` |
| --- | --- |
| `idx_orders_buyer_created_at` | напрям сортування колонки (`created_at DESC`) |
| `idx_orders_pending_created_at` | те саме (частковий `WHERE` якраз виражається) |
| `idx_users_lower_email` | індекс по **виразу** `lower(email)` |
| `idx_products_search_vector` | `USING GIN` |

Наслідки, перевірені повторним `migration:generate`:

* напрям сортування diff TypeORM **не порівнює** — обидва `DESC`-індекси
  фантомної різниці не дають;
* expression-індекс він теж лишає у спокої;
* а от GIN пропонує `DROP INDEX idx_products_search_vector` і створити його
  заново звичайним b-tree. Цю правку приймати не можна: b-tree не вміє оператор
  `@@`, і повнотекстовий пошук з ДЗ-12 просто перестав би використовувати індекс.

Генеровану колонку `products.search_vector` TypeORM, навпаки, описує повністю —
через `asExpression` + `generatedType: 'STORED'`.

### Підключення зі сховища

`src/data-source.ts` не має ані зашитого хоста з паролем, ані читання власного
env-файла: усі значення беруться з `process.env`, який наповнює
`scripts/with-secrets.sh`. Обгортка вміє дві форми — єдиний `DB_URL` (той, що
віддає сховище застосунку з ДЗ-11) і розібрані `DB_HOST`/`DB_PORT`/`DB_USER`/
`DB_PASSWORD`/`DB_NAME`.

```bash
bash scripts/with-secrets.sh dev  npm run migrate     # основний шлях
SKIP_VAULT=1 npm run migrate                          # CI та грейдер
```

Налаштувати сховище локально (один раз):

```bash
brew install infisical/get-cli/infisical
cp .secrets/infisical.env.example .secrets/infisical.env
$EDITOR .secrets/infisical.env     # INFISICAL_PROJECT_ID + client id/secret
```

`.secrets/` у `.gitignore`; у репозиторії лежить лише
`.secrets/infisical.env.example` із фейковими значеннями.

`SKIP_VAULT=1` — не обхід вимоги, а звичайний прод-патерн: у CI секрети
підкладає runner, а не CLI сховища. Перевірка стоїть у самій обгортці **після**
того, як slug оточення відрізано від аргументів, і **до** будь-якого звернення
до сховища — якби вона стояла вище за `shift`, обгортка зʼїла б перший аргумент
і спробувала виконати слово `dev` як команду.

## Конкурентність (ДЗ-14)

Головна операція домену — оформлення замовлення — виконується в **одній**
транзакції: декремент `stock`, списання балансу покупця, `INSERT` замовлення з
позицією і `INSERT` задачі на post-processing. Не вистачило товару або грошей —
відкочується все; замовлень без списаних грошей, як і списань без замовлення, не
існує за побудовою.

| Файл | Призначення |
| --- | --- |
| [`src/checkout.ts`](src/checkout.ts) | транзакційний checkout: атомарні `UPDATE … RETURNING` |
| [`src/retry.ts`](src/retry.ts) | обгортка повтору транзакції на 40001 / 40P01 |
| [`src/demo-race.ts`](src/demo-race.ts) | 50 паралельних checkout-ів на `stock = 10` |
| [`src/demo-workers.ts`](src/demo-workers.ts) | воркер-пул через `FOR UPDATE SKIP LOCKED` |
| [`src/demo-retry.ts`](src/demo-retry.ts) | serialization failure і повтор із backoff |
| [`src/entities/task.entity.ts`](src/entities/task.entity.ts) | outbox-черга задач |
| `src/migrations/*-ConcurrencyQueue.ts` | `users.balance_cents` + таблиця `tasks` |

### Числа з моїх запусків

`npm run demo:race` — 50 паралельних `checkout` на один товар, по 1 одиниці:

| | |
| --- | --- |
| спроб | 50 |
| успішних | **10** (= початковий `stock`) |
| фінальний `stock` | **0** |
| рядків із відʼємним `stock` | **0** |
| задач у черзі | 10 (по одній на замовлення) |
| відмов `out_of_stock` | 40 — транзакція відкотилась цілою |
| час | ~210 мс |

`npm run demo:workers` — 20 задач, 4 воркери, «робота» однієї 120 мс:

| | |
| --- | --- |
| розподіл | 5 / 5 / 5 / 5 |
| оброблено двічі | **0** (максимум `processed` на задачі — 1) |
| час | **760 мс** проти 2400 мс послідовно — 3.2× |
| холостих обертів | по 3 на воркера у кінці черги |

`npm run demo:retry` — 8 паралельних read-modify-write по −100 коп.:

| Фаза | Результат |
| --- | --- |
| A: `READ COMMITTED` без нічого | баланс 999 800 замість 999 200 — **6 апдейтів загубились тихо, помилок 0** |
| B: `REPEATABLE READ` + retry | піймано **21–24** конфліктів `40001`, 29–32 спроби на 8 транзакцій, баланс **999 200 = очікуваний** |

Фаза A тут не декорація: вона показує, що `READ COMMITTED` не кидає помилки —
він просто дає другій транзакції записати значення, порахуване зі старого
прочитаного. Гроші зникають без жодного сліду в логах.

### Атомарний UPDATE чи SELECT … FOR UPDATE

У checkout вибрано **атомарний UPDATE з умовою**:

```sql
UPDATE products SET stock = stock - $2
 WHERE id = $1 AND stock >= $2
 RETURNING id, price_cents, currency, stock
```

Він робить перевірку і зміну одним висловом, тож між «чи є 3 штуки» і «мінус
3 штуки» немає вікна, у яке вклиниться інша транзакція: Postgres бере рядковий
лок сам, а конкурент, що стояв на цьому локі, після його звільнення
переперевіряє `WHERE` за свіжою версією рядка і чесно не проходить. Нуль рядків
у `RETURNING` — це вже і є відповідь «товару немає», окремий `SELECT` не
потрібен, тобто на операцію йде один round-trip замість двох. Плюс `RETURNING`
приносить ціну, яка потрібна далі для суми замовлення.

`SELECT … FOR UPDATE` був би правильним вибором, якби між читанням і записом
треба було прийняти рішення, яке **не виражається в `WHERE`**: порахувати скидку
за історією покупця, звіритися з платіжним провайдером, застосувати правило з
конфігу. Тоді лок тримає рядок, поки логіка думає, і ніхто не змінить його
під нами. Ціна — довший лок і зайвий round-trip; у нашому checkout вони ні за що.

Обидва варіанти спираються на те саме: рішення приймає БД, а не JS. Read-modify-write
у застосунку (`SELECT` → порахувати в JS → `UPDATE`) не захищає ні той, ні
інший — і саме це показує фаза A в `demo:retry`.

Порядок локів у checkout однаковий у всіх викликах — спершу товар, потім
покупець. Саме тому 50 одночасних транзакцій не дають дедлоку: дедлок потребує
двох, що беруть ті самі локи у різному порядку.

Друга лінія захисту — констрейнти: `CHECK (stock >= 0)` на товарі й
`CHECK (balance_cents >= 0)` на користувачі. Якщо колись хтось напише
read-modify-write у JS, БД не дасть піти в мінус — операція впаде замість того,
щоб тихо продати неіснуючий товар.

### Чому retry ловить рівно два коди

| Код | Що це | Чому повтор доречний |
| --- | --- | --- |
| `40001` | `serialization_failure` — «could not serialize access due to concurrent update» | транзакція не виконалась, дані цілі, конфлікт залежав від збігу в часі |
| `40P01` | `deadlock_detected` — Postgres обрав жертву й відкотив її | те саме: повтор із джитером розводить транзакції в часі |

Усе інше повторювати шкідливо. `23505 unique_violation`, `23514 check_violation`,
`23503 foreign_key_violation` означають, що дані не такі, як думав код: повтор
дасть ту саму помилку, лише пізніше. `53300 too_many_connections` і
`57014 query_canceled` — проблема інфраструктури, її лікує бекофф на рівні вище,
а не повтор транзакції. Синтаксична помилка (`42601`) від повторів не зникає
взагалі. Тихо повторювати чужу помилку означає перетворити баг на загадкове
«іноді працює», тому обгортка прокидає нагору все, крім цих двох кодів.

Повторюється транзакція **цілком, разом із читаннями**: у новій транзакції новий
снапшот, і рішення треба приймати за свіжими даними. Повторити тільки запис зі
старим прочитаним значенням — це той самий lost update, просто під назвою retry.

Затримка — експоненційна з джитером (`base × 2^(n−1) × [0.5, 1.5)`). Без
випадкової складової ті самі дві транзакції прокинулись би одночасно й
зіштовхнулись знову.

### Черга задач і SKIP LOCKED

Задача на лист створюється в **тій самій транзакції**, що й замовлення — тому
черга живе таблицею в БД, а не в брокері (outbox-патерн). З брокером довелося б
або публікувати до `COMMIT` і слати листи про замовлення, яких не існує, або
після — і губити лист, якщо процес упав між `COMMIT` і `publish`.

Воркери беруть задачі так:

```sql
SELECT id, type FROM tasks
 WHERE status = 'pending'
 ORDER BY id
 FOR UPDATE SKIP LOCKED
 LIMIT 1
```

`FOR UPDATE` тримає рядок за воркером, `SKIP LOCKED` дозволяє решті не стояти в
черзі за цим локом, а брати наступну вільну задачу. Без `SKIP LOCKED` пул
виродився б у послідовну обробку; без `FOR UPDATE` двоє взяли б ту саму задачу,
і покупець отримав би два листи — саме це ловить лічильник `processed`, який має
лишатися рівним 1.

Транзакція тримається відкритою на весь час обробки: якщо воркер упаде до
`COMMIT`, лок зникне разом із його зʼєднанням, статус лишиться `pending`, і
задачу підбере інший. Порожній результат `SKIP LOCKED` означає «вільних немає
**зараз**», а не «черга порожня», тому воркер перепитує тричі з паузою, перш ніж
завершитись.

У пулі демонстративно змішані два способи вибірки: `worker-1` бере задачі через
QueryBuilder (`setLock('pessimistic_write')` + `setOnLocked('skip_locked')`),
решта — сирим SQL. Для Postgres це один і той самий запит, і вони чесно
конкурують між собою.

### Схема: де тепер джерело правди

`users.balance_cents` і таблицю `tasks` додає міграція
`*-ConcurrencyQueue.ts`. У `db/schema.sql` їх немає навмисно: цей файл —
знімок схеми ДЗ-12, а джерелом правди для структури з ДЗ-13 є міграції
(про це є рядок у розділі [ORM-шар](#orm-шар-дз-13)). Змішувати два шляхи не
варто: `psql -f db/schema.sql` на базі, де вже відпрацювали міграції, впаде.

## Data layer ops (ДЗ-15)

Два атрибути production-системи поверх дата-шару: пулер зʼєднань перед Postgres
і бекап, у відновленні якого є впевненість, бо його відновлювали.

| Файл | Призначення |
| --- | --- |
| [`pgbouncer/pgbouncer.ini`](pgbouncer/pgbouncer.ini) | конфіг пулера: `pool_mode = transaction`, адмін-консоль |
| [`pgbouncer/userlist.txt`](pgbouncer/userlist.txt) | дев-креденшели стенда для SCRAM-автентифікації |
| [`scripts/backup.sh`](scripts/backup.sh) | `pg_dump -Fc` у файл із датою + контрольне значення поруч |
| [`scripts/restore-drill.sh`](scripts/restore-drill.sh) | відновлення у чистий контейнер і порівняння «до/після» |
| [`scripts/lib-db.sh`](scripts/lib-db.sh) | розбір `DATABASE_URL`, запуск `psql`/`pg_dump` |
| [`backup.cron`](backup.cron) | нічний розклад |
| [`RESTORE-DRILL.md`](RESTORE-DRILL.md) | протокол drill-у: дата, розмір, час, RTO і RPO |

### Підняти і перевірити

```bash
docker compose up -d --wait

# застосунок ходить сюди — порт 6432 це PgBouncer
psql -h 127.0.0.1 -p 6432 -U marketplace -d marketplace -c "SELECT 1"

# адмін-консоль пулера
PGPASSWORD=dev_admin_0 psql -h 127.0.0.1 -p 6432 -U pgbouncer_admin -d pgbouncer -c "SHOW POOLS"
```

Якщо `docker compose logs pgbouncer` скаржиться на конфіг: образ
`edoburu/pgbouncer` за документацією читає саме змонтовані
`/etc/pgbouncer/pgbouncer.ini` і `/etc/pgbouncer/userlist.txt` (так він тут і
підключений). На випадок зміни поведінки образу достатньо дописати сервісу
`command: ["/usr/bin/pgbouncer", "/etc/pgbouncer/pgbouncer.ini"]` — тоді
entrypoint обходиться стороною й запускається рівно наш конфіг.

`SHOW POOLS` показує базу `marketplace` з `pool_mode = transaction`. Рядок
підключення у сховищі (ДЗ-11) і контракт у `.env.example` вказують на `:6432`;
прямий `:5432` лишається опублікованим свідомо — для `pg_dump`, `pg_restore` і
ротації пароля, яким потрібна сесія.

Що це дає, виміряно на цьому стенді: `npm run demo:race` відкриває **55
клієнтських зʼєднань**, а Postgres під час цього бачить **8 серверних бекендів**
(`default_pool_size = 8`). Усі 50 паралельних checkout-ів відпрацювали так само
коректно — 10 успішних, `stock = 0`, `oversell = 0`. Тобто пулер прибрав
зростання числа бекендів, не змінивши семантики транзакцій.

### Чому transaction mode і що він ламає

`session` (режим за замовчуванням) закріплює серверне зʼєднання за клієнтом на
весь час його життя. Для застосунку з пулом на 50 зʼєднань це означає 50 бекендів
у Postgres — тобто пулер не дає нічого, крім зайвого стрибка в мережі. `statement`
звільняє зʼєднання після кожного вислову й тому взагалі забороняє багатовислівні
транзакції — наш `checkout` із чотирьох кроків у ньому неможливий.
`transaction` — єдиний режим, у якому і транзакції цілі, і серверних зʼєднань
залишається вісім на двісті клієнтів.

Ціна в тому, що між двома транзакціями одного клієнта серверне зʼєднання може
бути вже іншим. Ламається все, що тримає стан у **сесії**, а не в транзакції:

1. **`SET` рівня сесії.** `SET search_path`, `SET statement_timeout`,
   `SET TIME ZONE`, зроблені поза транзакцією, зникають: наступна транзакція
   поїде на інший бекенд. Тихо, без помилки — і це найгірший варіант.
   Лікується `SET LOCAL` усередині транзакції або параметрами в рядку підключення.
2. **Named prepared statements.** `PREPARE` на одному бекенді, `EXECUTE` на
   іншому — `prepared statement "s1" does not exist`. Драйвери, що кешують
   запити за іменем (JDBC, `asyncpg`), падають одразу. `node-postgres`, на якому
   стоїть TypeORM, за замовчуванням надсилає **неназвані** запити, тож нас це не
   чіпає; на випадок зміни драйвера в конфізі стоїть
   `max_prepared_statements = 200` — PgBouncer ≥ 1.21 відстежує такі запити й
   перевиконує `PREPARE` на новому зʼєднанні сам.
3. **`LISTEN` / `NOTIFY`.** Підписка належить сесії. У transaction mode зʼєднання
   повертається в пул одразу після транзакції, і сповіщення нікуди не приходить.
   Саме тому черга задач у цьому проєкті зроблена таблицею і
   `FOR UPDATE SKIP LOCKED` (ДЗ-14), а не на `LISTEN/NOTIFY`.
4. **Сесійні advisory-локи.** `pg_advisory_lock()` утримується до кінця сесії —
   тобто до моменту, який клієнт більше не контролює: лок або «втече» на чуже
   зʼєднання, або не звільниться взагалі. Транзакційний варіант
   `pg_advisory_xact_lock()` знімається на COMMIT і працює коректно.
5. **Тимчасові таблиці й курсори `WITH HOLD`.** `CREATE TEMP TABLE` живе в сесії;
   наступна транзакція її вже не побачить.
6. **`pg_dump` / `pg_restore`.** `pg_dump` відкриває транзакцію, фіксує їй
   snapshot і може чіпляти паралельні зʼєднання до того самого snapshot —
   транзакційний пулер роздасть ці зʼєднання різним бекендам. Тому
   `scripts/backup.sh` свідомо ходить **напряму** в `:5432`, і друкує це в лозі.

Ще одна взаємодія, вже не з лекції, а з нашим ДЗ-11: ротація пароля БД.
PgBouncer автентифікує клієнтів за `userlist.txt`, тож після `rotate.sh` пароль у
базі новий, а пулер знає старий — застосунок через пулер отримає помилку входу.
Для стенда лікується оновленням `userlist.txt` і `RELOAD` у адмін-консолі; у
проді правильна відповідь — `auth_query`: пулер питає хеш у самого Postgres і
статичного файла з паролями не тримає взагалі.

### Бекап

```bash
bash scripts/with-secrets.sh dev bash scripts/backup.sh
```

Складає `pg_dump -Fc` у `backups/marketplace_<дата>_<час>.dump` (тека в
`.gitignore` — дампи це артефакти, не код) і поруч два службові файли:

* `*.checksum` — `count|sum` по `orders` **на момент дампу**. Саме з цим числом
  порівнює drill: порівнювати з живою базою нечесно, вона вже змінилась.
* `*.sha256` — цілісність самого архіву.

Скрипт друкує шлях створеного файла, розмір, час і кількість записів TOC
(`pg_restore --list` читається — доказ валідного `-Fc` архіву), і прибирає копії
старші за останні `BACKUP_KEEP` (типово 14 — два тижні нічних бекапів).

Рядок підключення береться тільки з оточення (`DATABASE_URL`/`DB_URL`), який
наповнює обгортка сховища. Пароль може бути відсутній у DSN — тоді скрипт візьме
його з файла-секрета `secrets/db_password`, тобто з того самого джерела, що й
застосунок. Призначення — локальна тека; перенесення в S3 заплановане на ДЗ-26,
і ключі тоді ляжуть у те саме сховище, а не в новий env-файл.

Розклад — у [`backup.cron`](backup.cron): `17 3 * * *`, щоночі о 03:17 (не рівно
о третій, щоб не збігатися з усіма іншими нічними задачами). Перед встановленням
замінити шлях до репозиторію: у cron немає ані `cwd`, ані вашого `PATH`.

```bash
crontab backup.cron && crontab -l
```

### Відновлення

```bash
bash scripts/with-secrets.sh dev bash scripts/restore-drill.sh      # друкує MATCH
```

Скрипт бере найсвіжіший дамп, створює **новий** том і контейнер
`postgres:16-alpine`, відновлює туди з `--no-owner --no-acl` (ролі `marketplace`
у чистому контейнері немає), знімає `count|sum` і порівнює з `*.checksum`.
Прибирає за собою в `trap` — навіть якщо впав посередині, тож повторний запуск
теж дає `MATCH`: кожен прогін починається з порожнього тому.

Якщо Docker недоступний (CI-раннер без DinD), скрипт робить те саме в
тимчасовому кластері Postgres, який сам створює через `initdb` і сам зносить.
Режим він друкує у першому ж рядку, щоб не було сумнівів, що саме перевірено.

Виміряні числа — у [RESTORE-DRILL.md](RESTORE-DRILL.md): на обсязі сіду
відновлення займає 1,3 с, на 200 тис. замовлень (дамп 12 MB) — 6,8 с; RPO
нічного розкладу — 24 години, і там же розписано, чим його зменшують.

## Тестування (ДЗ-16)

Чотири команди — чотири рівні, і жодна з них нічого не мокає:

```bash
npm run test:integration   # репозиторії проти справжнього Postgres (testcontainers)
npm run test:e2e           # наскрізний сценарій через HTTP на повному AppModule
npm run test:contract      # consumer-контракт -> pacts/marketplace-web-marketplace-api.json
npm run verify:provider    # справжній застосунок проти цього контракту
```

Порядок має значення лише в одному місці: `verify:provider` читає контракт, який
створює `test:contract`. На свіжому клоні — спочатку `test:contract`.

`npm test` запускає integration, e2e і consumer-контракт одним прогоном; окремі
конфіги (`jest.integration.config.js` і далі) відрізняються тільки `testRegex`,
база — спільна в `jest.config.js`. Там же `reporters: ['default']` і
`maxWorkers: 1`.

Provider-верифікація у спільний прогін свідомо не входить: вона перевіряє
застосунок проти контракту, який створює consumer-тест, тож на свіжому клоні
артефакта ще немає, а порядок файлів у jest не гарантований — спільний прогін
був би зеленим або червоним залежно від того, який файл запустився першим. Це
окремий крок конвеєра: `npm run test:contract`, потім `npm run verify:provider`
(саме так їх і викликає джоба `contract` у CI).
`reporters` задано явно не для краси: Jest 30 сам визначає оточення
(`detectAgent()`) і під агентом/у CI тихо підміняє репортер на компактний, після
чого в лозі немає рядків `PASS …` і не видно, що саме пройшло. Явний `default`
вимикає цю евристику.

### Що саме перевіряється

| Рівень | Файли | Чого це коштує | Що ловить |
| --- | --- | --- | --- |
| integration | `test/integration/*.spec.ts` (18 тестів) | контейнер Postgres на файл | FK/UNIQUE/CHECK-констрейнти, повнотекстовий пошук на `tsvector`, атомарний `UPDATE … WHERE stock >= …`, `LEFT JOIN + json_agg` і `GROUP BY`-звіт |
| e2e | `test/e2e/*.e2e-spec.ts` (8 тестів) | контейнер + повний Nest-застосунок | happy path `GET /products → POST /orders → GET /orders/{id}`, негативні кейси, де 400 віддає валідатор зі спеки ДЗ-09, а 404 — `problem+json`, плюс realtime ДЗ-18: SSE з `Last-Event-ID` та ізоляція WS-кімнат |
| contract | `test/contract/*.consumer.spec.ts` (2 тести) | лише mock-сервер pact | форму відповіді, якої чекає фронтенд: `price_cents` цілим, `next_cursor` nullable |
| provider | `test/contract/*.provider.spec.ts` (1 тест) | контейнер + застосунок + pact-ядро | що застосунок справді віддає те, що записано в контракті |

Integration-тести ходять у БД через `src/repositories/*` — тонкий шар над `pg`,
який приймає будь-який `Queryable` (пул або окремий клієнт). Ця абстракція
зʼявилася саме через ізоляцію: щоб тест міг підсунути репозиторію клієнта з
відкритою транзакцією.

E2E і provider піднімають застосунок через `src/bootstrap.ts` —
`configureApp(app)` ставить рівно ті самі middleware в тому самому порядку, що й
`main.ts` (`express.json` → `express-openapi-validator` зі спеки → роути →
глобальний `problem+json`-фільтр). Без цього винесення тест перевіряв би інший
застосунок, ніж той, що йде в прод, і «400 від валідатора» в тесті був би
вигадкою.

База в тестах приходить тим самим шляхом конфігурації, що в проді: URI
контейнера розбирається на `DB_URL` без пароля і тимчасовий `DB_PASSWORD_FILE`
(zod-схема ДЗ-11 пароля в DSN не приймає). Тобто e2e заодно перевіряє і
конфігураційний контракт.

### Ізоляція: ROLLBACK для integration, TRUNCATE для e2e

Це свідомо різні стратегії, бо випадки різні.

**Integration — транзакція + `ROLLBACK`** (`useRollbackTransaction`): кожен тест
отримує власний клієнт із відкритою транзакцією, після тесту — `ROLLBACK`. База
не змінюється взагалі, тому порядок тестів не має значення і чистити нічого не
треба — найдешевший варіант, коли весь тест живе в одному зʼєднанні.

Чого ця стратегія **не** дає — зеленого прогону. Вона прибирає стан, а не
недетермінізм у самому коді, і тут це вилізло буквально: тест із `GROUP BY`
падав у 6 прогонах із 13, і `ROLLBACK` був ні до чого. `OrdersRepository.create()`
ставив `paid_at` клієнтським `new Date()` проти серверного `created_at DEFAULT
now()`, і CHECK `orders_paid_at_sane` (`paid_at >= created_at`) валив вставку.

Цікаве тут — чому саме «6 із 13», а не всі 13. Поза транзакцією клієнтський час
менший за серверний завжди (200 замірів із 200, і 50 падінь на CHECK із 50:
`new Date()` має роздільність мілісекунди проти мікросекунд у `now()`). Але
всередині транзакції `now()` — це час її **початку**, зафіксований на `BEGIN`,
тому результат залежить від того, скільки запитів тест устиг зробити до
`create()`: заміряно 95 порушень зі 100 без жодного запиту, 68 — після двох,
51 — після пʼяти. Тест із `GROUP BY` робить до `create()` рівно пʼять вставок.
Звідси ж і враження, що «на повільній БД усе гаразд»: там кожен попередній запит
відсуває клієнтський час далі від `BEGIN`.

Виправлено там, де й має бути, — у SQL: `paid_at` ставить `now()`, однакове для
обох колонок, і це закріплено окремим тестом (`paid_at` мусить дорівнювати
`created_at` точно).

Обмеження, яке теж варто знати: зміни в транзакції невидимі іншим зʼєднанням,
тому справжню конкурентність (два паралельних checkout) так не напишеш — для неї
є окремі демо `src/demo-*.ts`, які працюють із закомічених даних.

**E2E — `TRUNCATE … RESTART IDENTITY CASCADE`** перед кожним кейсом: тут
`ROLLBACK` не працює в принципі, бо застосунок ходить у базу **власним пулом** і
транзакції тесту просто не бачить. `RESTART IDENTITY` потрібен, щоб id не
«текли» між кейсами, `CASCADE` — бо на `orders` посилаються `order_items` і
`tasks`. Платимо за це швидкістю (`TRUNCATE` на кожен кейс) і тим, що e2e не
можна ганяти паралельно по одній БД — звідси `maxWorkers: 1`.

### Test data builders

`test/support/builders.ts`: `aUser()`, `aProduct()`, `anOrder()` повертають
валідний обʼєкт із дефолтами й приймають часткове перевизначення. У тесті видно
лише те, що для нього справді важливо:

```ts
const productId = await insertProduct(q(), sellerId, aProduct({ priceCents: 100_000 }));
```

Унікальність (email, `sku`) дає `uniqueSuffix()`, тож білдери не конфліктують між
собою навіть без очищення БД.

### Контракт і брокер

Контракт описує уявний фронтенд `marketplace-web` проти провайдера
`marketplace-api`, шляхи взяті зі спеки ДЗ-09 (`/products`, `/products/{id}`).
Значення задані матчерами, а не константами: контракт має ламатися від зміни
**форми** відповіді, а не від того, що в базі інший товар.

Provider-верифікація сідає БД через `stateHandlers` — по одному на кожен
`given(...)` консюмера, з параметрами з контракту (`id`, `name`, `priceCents`),
тож провайдер не вгадує дані, а отримує їх.

`pacts/` — **у `.gitignore`**: це згенерований артефакт consumer-тесту, а не
джерело правди. Джерело правди — сам consumer-тест і брокер; тримати машинний
JSON у git означало б розвʼязувати в ньому конфлікти і рано чи пізно верифікувати
застарілу копію.

Брокер — сервіс `pact-broker` у `docker-compose.yml` (разом зі службовою БД
`pact-broker-db`), слухає `127.0.0.1:9292`:

```bash
npm run pact:broker       # docker compose up -d --wait pact-broker
open http://127.0.0.1:9292
```

Перший старт довгий: брокер — Rails-застосунок і накатує власні міграції, тому в
healthcheck стоїть `start_period: 120s` — щоб `docker compose up -d --wait` не
впав на таймауті.

Адреса й токен брокера читаються **лише** з `PACT_BROKER_URL` і
`PACT_BROKER_TOKEN`; у коді їх немає. Локально їх підкладає сховище ДЗ-11
(`bash scripts/with-secrets.sh dev npm run verify:provider`), у CI — secrets
GitHub. Локальний стенд авторизації не має, тому `PACT_BROKER_TOKEN` там просто
відсутній, і ключ у опції верифаєра не додається взагалі (pact-js валідує опції
за наявністю ключа: `pactBrokerToken: undefined` падає з `TypeError`).

### Гейт can-i-deploy

```bash
npm run pact:gate         # bash scripts/pact-gate-demo.sh
```

Скрипт проходить послідовність, яку повторює джоба `contract` у
`.github/workflows/contract.yml`:

1. `docker compose up -d --wait pact-broker`
2. публікація контракту: `PUT /pacts/provider/marketplace-api/consumer/marketplace-web/version/<v>`
3. `npm run verify:provider` із `PACT_BROKER_URL` — результат верифікації їде в брокер (`publishVerificationResult: true`)
4. `PUT /pacticipants/marketplace-api/versions/<v>/tags/prod` — «у prod стоїть ця версія провайдера»
5. `GET /can-i-deploy?pacticipant=marketplace-web&version=<v>&to=prod`

Публікація, тег і сам гейт — звичайний HTTP API брокера через `curl`: ні
`pact-broker` CLI, ні ruby-гемів ставити не треба.

Крок 5 викликається **двічі** — до кроку 4 і після, — і це і є вся суть гейта.

До тегу:

```
5/5 can-i-deploy ДО тегу prod (очікуємо deployable: null, unknown: 1)
  summary: {"deployable":null,"reason":"There is no verified pact between version d56ba65-191454 of marketplace-web and the version of each provider currently in prod","success":0,"failed":0,"unknown":1}
  -> гейт НЕ пускає: у prod немає версії провайдера, з якою порівнювати
```

Після тегу:

```
5/5 can-i-deploy ПІСЛЯ тегу prod (очікуємо deployable: true)
  summary: {"deployable":true,"reason":"All required verification results are published and successful","success":1,"failed":0,"unknown":0}
  -> гейт пускає: контракт консюмера верифіковано версією провайдера в prod
```

Різниця одна: `unknown: 1` проти `success: 1`. `deployable: null` — це не «ні, не
можна», а «не знаю»: у `prod` немає жодної версії провайдера, з верифікацією якої
можна було б зіставити цей контракт. Гейт має валити деплой і в цьому випадку —
тому в CI перевірка написана як `deployable !== true`, а не `deployable === false`.
Формулювання `reason` залежить від версії брокера; значущі саме `deployable`,
`unknown` і `success`.

Версії в демо — `<короткий sha>-<HHMMSS>`: суфікс потрібен, щоб демо можна було
ганяти повторно (після першого прогону версія цього коміту вже протегована
`prod`, і другий запуск показав би одразу зелений гейт). У CI суфікса немає —
там версія це `github.sha`, по одній на коміт.

### CI

`.github/workflows/contract.yml`, дві джоби:

- `tests` — `tsc --noEmit`, `test:integration`, `test:e2e`. На `ubuntu-latest`
  Docker уже є, тож testcontainers працює без service-контейнерів.
- `contract` — кроки 1–5 вище. Крок `can-i-deploy` парсить відповідь і виходить з
  кодом 1, якщо `summary.deployable !== true`, — джоба падає разом із ним.
  Контракт і відповідь гейта лишаються артефактом збірки.

Якщо секрету `PACT_BROKER_URL` немає (форк, свіжий репозиторій), джоба підіймає
брокер зі стенда проєкту й працює автономно.

### Якщо реєстр образів недоступний

`startTestDatabase()` бере `TEST_DATABASE_URL` (або `DATABASE_URL`), якщо він є в
оточенні, і тоді контейнер не підіймається — тести йдуть у вказану базу. Це
потрібно для CI із service-контейнером Postgres і для середовищ без доступу до
реєстрів образів:

```bash
TEST_DATABASE_URL=postgres://marketplace:dev_password_0@127.0.0.1:5432/marketplace_test \
  npm run test:integration
```

У звичайному локальному прогоні змінної немає й працює саме testcontainers.

Один момент, який видно лише в цьому режимі: `npm test` ганяє всі п'ять файлів
по одній базі, а e2e і provider **комітять** (у них ізоляція через `TRUNCATE`).
Тому кожен integration-файл бере собі відому точку відліку — один `TRUNCATE` у
`beforeAll`, до всіх тестів. Інакше перевірка «знайшовся рівно один товар»
побачила б чуже. З testcontainers це no-op: контейнер на файл і так чистий.

## Realtime: WebSocket + SSE (ДЗ-18)

Один потік подій, два транспорти. Коли міняється статус замовлення, подія
`order.status` їде і в WebSocket-кімнату `orders:<id>`, і в SSE-потік
`GET /orders/<id>/events` — бо обидва підписані на ту саму шину.

```bash
npm start                      # tsc -> node dist/main.js, порт 3000

# змінити статус (звідси народжується подія)
curl -s -X PATCH http://localhost:3000/orders/o_1/status \
  -H 'Content-Type: application/json' -d '{"status":"paid"}'

# читати потік того самого замовлення
curl -sN http://localhost:3000/orders/o_1/events
```

У відповіді:

```
retry: 1000

id: 1
event: order.status
data: {"id":1,"at":"2026-10-10T18:02:08.888Z","order_id":"o_1","status":"paid","previous_status":"created"}
```

`npm start` — це `tsc` і потім `node dist`, а не `tsx`: декоратори Nest
(`@WebSocketGateway`, `@SubscribeMessage`, інжекція в конструктор) тримаються на
`emitDecoratorMetadata`, якого `tsx` не емітить. Під `tsx` gateway підніметься
без помилки й просто не отримає залежностей.

### Хто кому належить

Авторизації в API немає свідомо (`security: []` у спеці ДЗ-09), але кімната
мусить комусь належати — інакше в `join` нема що перевіряти. Тому в замовлення
зʼявилося поле `buyer_id`, а клієнт WebSocket передає себе в handshake:

```js
io('http://localhost:3000', { auth: { userId: 'u_1' } });
socket.emit('join', { orderId: 'o_1' }, (ack) => console.log(ack));
// { ok: true, room: 'orders:o_1', lastEventId: 4 }
```

`join` відмовляє трьома способами, і всі три перевіряє демо нижче:

| Хто | Відповідь |
| --- | --- |
| анонім (немає `auth.userId`) | `{ ok: false, error: 'anonymous' }` |
| чужий (`userId` ≠ `buyer_id`) | `{ ok: false, error: 'forbidden' }` |
| неіснуюче замовлення | `{ ok: false, error: 'not_found' }` |

Відмова — саме відмова з ack, а не тиха порожня кімната: клієнт має дізнатися,
що він НЕ підписаний, інакше він вічно чекатиме подій, яких не буде.

На SSE і на `PATCH .../status` цієї перевірки **немає**: обидва ендпоїнти
читаються й викликаються анонімно, бо саме так їх перевіряють критерії ДЗ
(`curl` без заголовків). У проді на них вішається той самий guard, що й на
`join` — місце для нього позначено коментарем у `orders.controller.ts`.

### Last-Event-ID: доганяємо пропущене

Кожна подія має номер, що зростає **в межах замовлення**. Клієнт, який
перепідключився, повертає останній відомий номер — сервер віддає з буфера те,
що більше за нього, і лише потім переходить у режим реального часу:

```bash
curl -sN -H 'Last-Event-ID: 3' http://localhost:3000/orders/o_1/events | grep '^id:'
# id: 4
# id: 5
```

Буфер — останні 100 подій на замовлення, у памʼяті процесу. Запит без
`Last-Event-ID` віддає весь наявний буфер: для потоку статусів «історія + далі
наживо» корисніша за «тільки нове», а клієнт, якому історія не потрібна, просто
надсилає номер.

Перший рядок потоку — `retry: 1000`. Без нього браузер бере власний дефолт у
кілька секунд, і реконект виглядає як зависання.

### Демо ізоляції кімнат

```bash
# основний: клієнти в РІЗНИХ кімнатах — B не має чути подію замовлення A
node scripts/realtime-demo.mjs;             echo "exit=$?"
# A_RECEIVED=1
# B_RECEIVED=0
# exit=0

# контрольний: обидва клієнти в кімнаті замовлення A — B МУСИТЬ почути
node scripts/realtime-demo.mjs --same-room; echo "exit=$?"
# A_RECEIVED=1
# B_RECEIVED=1
# exit=0
```

Обидва прогони — один і той самий код: прапорець міняє лише кімнату другого
клієнта і, звідти ж, очікуване значення. Скрипт, який друкував би константу
`B_RECEIVED=0`, на контрольному прогоні себе викриє.

Що це справді вимірює, перевірено мутацією: якщо замінити
`server.to(room).emit(...)` на `server.emit(...)` (слати всім), основний прогін
одразу стає червоним —

```
A_RECEIVED=1
B_RECEIVED=1
[demo] ПОМИЛКА: ізоляція порушена: B отримав подію чужої кімнати
exit=1
```

— а контрольний лишається зеленим. Саме різниця між двома прогонами і є
доказом; окремо кожен із них нічого не доводить.

Скрипт також друкує `DENIED_ANONYMOUS=1` і `DENIED_FOREIGN=1` — ті самі
перевірки `join` із таблиці вище, і вони теж впливають на код виходу.

### Два інстанси: що зламається

Кімнати socket.io та буфер подій живуть **у памʼяті процесу**. На двох
інстансах за балансувальником клієнт, що тримає сокет на інстансі №1, не
отримає події, яку згенерував інстанс №2 (а `Last-Event-ID` на «чужому»
інстансі віддасть порожньо, бо там інший буфер) — лікується спільною шиною:
`@socket.io/redis-adapter` для розсилки між інстансами плюс спільне сховище
подій (Redis Streams або та сама таблиця `tasks` у Postgres) замість буфера в
памʼяті. Для одного інстанса все це зайве, тому тут його свідомо немає.

## Trade-offs: WebSocket vs SSE

| Критерій | WebSocket (socket.io) | SSE (`text/event-stream`) |
| --- | --- | --- |
| Напрям каналу | Двобічний: клієнт шле `join`, сервер — події. Кімнати й ack безкоштовні | Односторонній, сервер → клієнт. Усе «від клієнта» — окремим HTTP-запитом |
| Реконект і відновлення | Реконект із коробки, але «що я пропустив» доводиться робити руками (тут — `lastEventId` в ack) | Реконект і `Last-Event-ID` — частина стандарту; `EventSource` надсилає заголовок сам |
| Вимоги до інфраструктури | Апґрейд протоколу: потрібна підтримка в балансувальнику й проксі, sticky sessions, окремий адаптер на кілька інстансів | Звичайний HTTP-запит: проходить скрізь, де проходить `GET`; треба лише вимкнути буферизацію (`X-Accel-Buffering: no`) |
| Ціна на подію | Кадр у вже відкритому сокеті — кілька байтів службових даних | Текстовий блок у відкритій відповіді, трохи більше службових байтів; на реконекті — повноцінний HTTP-запит із заголовками |
| Підтримка в браузері | Бібліотека на клієнті (socket.io-client ≈ 40 КБ) | `new EventSource(url)`, нуль залежностей |
| Що видно в DevTools | Окрема вкладка WS, кадри треба розгортати | Звичайний запит у Network, тіло читається очима |

Для нотифікацій про статус замовлення в проді я лишив би **SSE**. Потік тут
односторонній — сервер повідомляє, клієнт не відповідає, — а все, що в
WebSocket доводиться дописувати (нумерація подій, добір пропущеного після
обриву), у SSE вже є стандартом і працює без бібліотеки на клієнті. WebSocket
виправданий там, де клієнт теж постійно шле дані в той самий канал: чат,
спільне редагування, трейдинг-термінал. Ціна помилки тут асиметрична: зайвий
WebSocket — це sticky sessions, Redis-адаптер і окрема гілка в конфігурації
балансувальника заради каналу, яким у зворотний бік ніхто не користується.

## Async-події через RabbitMQ (ДЗ-19)

У ДЗ-18 подія доїжджала тому, хто підключений просто зараз: немає одержувача —
немає доставки. Тут між сервісом і його читачами зʼявився посередник, який
тримає повідомлення до появи одержувача. Це вся різниця між транспортом і
брокером — і платиться вона трьома окремими рахунками: робота може зникнути,
виконатись двічі або застрягти назавжди.

```bash
docker compose up -d --wait          # rabbitmq: healthcheck на check_running
npm run build
npm run migrate && npm run seed

npm run demo:publish                 # happy path: 5 подій -> 5 ефектів
npm run demo:dlq                     # отруєне повідомлення -> окремий контур
npm run demo:duplicate               # дубль доставлено, ефект один
```

Вебморда менеджменту — http://127.0.0.1:15672 (app / app). Саме там видно
`x-death` отруєного повідомлення очима, і саме тому образ узято з суфіксом
`-management`.

### Топологія

| Обʼєкт | Імʼя | Навіщо |
| --- | --- | --- |
| topic-exchange | `shop.events` | куди продюсер кладе факти домену |
| черга (quorum) | `shop.order.placed` | робоча черга під `order.placed` |
| binding | `shop.events` → `shop.order.placed` за `order.placed` | без нього routing key — порожній звук |
| DLX | `shop.events.dlx` | окремий контур для мертвих повідомлень |
| DLQ (quorum) | `shop.order.placed.dlq` | куди вони лягають, з `x-death` у заголовках |

Оголошує все це `src/messaging/topology.ts`, і викликають його споживач та
демо — **не продюсер**. Продюсер не має знати, хто його слухає: він публікує
факт у exchange із routing key, і все.

Зворотний бік цього поділу: routing key без відповідного binding — порожній
звук. Брокер коректно викине повідомлення і **при цьому поверне позитивний
confirm**, бо зі свого боку він усе зробив правильно. Тому публікація йде з
`mandatory: true` і слухачем `basic.return`, а демо друкує `unroutable=0` —
інакше «опублікував 5» могло б означати «5 повідомлень поїхало в нікуди».
Дешевша альтернатива для великої системи — alternate exchange: одне
налаштування на exchange замість прапорця на кожній публікації.

Черги — `quorum`. Головна причина: в них працює `x-delivery-limit` (тут 5), а
без нього повідомлення, яке споживач безкінечно повертає в чергу, крутиться
там вічно і гріє кластер. Класичне дзеркалювання (`ha-mode`) не
налаштовується: воно прибране з RabbitMQ 4.0.

Версія брокера — `rabbitmq:4.2-management`: 4.2 — LTS-серія з підтримкою до
30.06.2030, тоді як поточна 4.3 підтримується до 30.04.2028.

### Подія виходить із бізнес-операції

`order.placed` публікується в `src/checkout.ts` — тій самій транзакційній
операції з ДЗ-14, — **після COMMIT**:

```ts
const result = await dataSource.transaction((m) => checkoutInTransaction(m, input));
if (publisher) await publisher.publish(buildOrderPlacedEvent({ … }));
```

Це свідомий вибір із двох поганих. Публікація до коміту розповіла б про
замовлення, якого може не стати. Ціна вибору — вікно між `COMMIT` і `publish`:
процес, що впав саме тут, лишає замовлення без події. Закриває це вікно не
акуратніший порядок викликів, а **outbox** — запис події в ту саму транзакцію
й окремий відправник. Це ДЗ-22; таблиця `tasks` для цього вже є з ДЗ-14.

У тілі — спроектований контракт, а не ORM-сутність через spread:

```json
{
  "eventId": "evt_order_placed_14",
  "type": "order.placed",
  "occurredAt": "2026-10-15T09:00:00.000Z",
  "version": 1,
  "data": { "orderId": "14", "buyerId": "1", "productId": "1", "quantity": 1,
            "totalCents": 249900, "currency": "UAH" }
}
```

`eventId` **стабільний**: він виводиться з факту (`evt_order_placed_<orderId>`),
а не з моменту публікації. Свіжий uuid на кожну спробу зламав би все, що нижче:
повторна публікація після обриву створила б подію, якої споживач не впізнав би
як дубль.

### prefetch = 10

Дефолт брокера — `0`, і нуль означає **без ліміту**: перший підписаний споживач
забирає всю чергу, другий простоює. Число тут виставлене явно
(`channel.prefetch(10)`, значення з `BROKER_PREFETCH`) і тримається орієнтиру
**prefetch × час обробки < consumer_timeout**: ефект — один `INSERT … ON
CONFLICT` на 2–5 мс, тож 10 × 5 мс = 50 мс проти стокових 30 хвилин, тобто
запас на чотири порядки. Менше теж працювало б, але `prefetch=1` — правильна
відповідь для важких задач і найгірша для задач по кілька мілісекунд: на кожне
повідомлення довелося б по круговому запиту до брокера. Стеля — 2000, це
жорстке обмеження quorum-черг.

### Три рахунки і чим за них заплачено

| Ризик | Де він проявляється | Чим платимо |
| --- | --- | --- |
| Робота зникає | autoAck: брокер вважає повідомлення доставленим у момент відправки, падіння забирає все вікно prefetch | `noAck: false` і `ack` **після** ефекту |
| Робота дублюється | ack не доїхав, брокер повернув повідомлення | ідемпотентний ефект: `INSERT … ON CONFLICT ("eventId") DO NOTHING` |
| Робота застрягає | повідомлення, яке не обробиться ніколи, крутиться в черзі вічно | `reject(requeue=false)` → DLX → DLQ, плюс `x-delivery-limit` |

Ефект живе в `picking_tasks` — тій самій базі, де решта даних. Це важливо:
дедуп у памʼяті процесу (`Set`/`Map`) не рахується, бо гарантія живе рівно
стільки, скільки інстанс, і не існує між двома подами.

І два різні слова, які легко сплутати. **Ідемпотентність** — властивість
операції: «вставити рядок із цим ключем» нею володіє, `qty = qty - 1` — ні.
**Ключ ідемпотентності** — інструмент, яким неідемпотентну операцію роблять
безпечною для повтору. Тут обрано перше: ефект виражений через природний ключ,
тому окреме сховище оброблених id не потрібне взагалі.

### Чому це at-least-once, а не exactly-once

Exactly-once **на рівні доставки не існує ні в кого** — ні в RabbitMQ, ні в
Kafka, ні деінде: між «брокер віддав повідомлення» і «споживач підтвердив» є
мережа, і будь-яке підтвердження може загубитись саме після того, як робота
вже зроблена. Брокеру лишається вибір із двох: підтвердити рано і втратити
роботу, або повторити й доставити двічі. RabbitMQ обирає друге — це і є
**at-least-once**.

Те, що тут зроблено, — не «увімкнув exactly-once», а дві окремі речі, які
разом дають **exactly-once результат**:

1. **at-least-once доставка**: `noAck: false`, `ack` після ефекту, `reject` у
   DLQ для непридатного. Повтор можливий і очікуваний.
2. **ідемпотентний ефект**: `INSERT INTO picking_tasks … ON CONFLICT
   ("eventId") DO NOTHING`. Повтор не подвоює роботу.

`demo:duplicate` показує обидві половини одночасно: `deliveries=2` (доставка
справді повторилась) при `effect=1` (результат один). Якби там було
`deliveries=1`, демо не довело б нічого — це означало б лише, що дубля не
сталося.

Межа, якої це ДЗ не переходить: щілина між «ефект застосовано» і «ack
надіслано» дає повторну доставку (її й показує демо), а зворотна щілина —
«позначку поставлено, ефекту немає» — закривається не меншою щілиною, а
спільною транзакцією позначки й ефекту. Це ДЗ-22.

### Числа трьох прогонів

`npm run demo:publish` — пʼять замовлень через `checkout`, пʼять подій, пʼять
ефектів:

```
published=5
delivered=5
effect=5
acked=5
work=0
dlq=0
unroutable=0
prefetch=10
```

`npm run demo:dlq` — подія без `eventId` не стане валідною від повтору, тож
споживач відповідає `reject(requeue=false)`, і повідомлення їде окремим
контуром. Причина читається з `x-first-death-reason` (з відкотом на `x-death`
для старших брокерів):

```
[consumer] отруєне повідомлення -> DLQ: немає eventId — нічим упізнати дубль
rejected=1
work=0
dlq=1
dlq-reason=rejected
effect=0
prefetch=10
```

Причин dead-letter у RabbitMQ рівно чотири: `rejected`, `expired`, `maxlen`,
`delivery_limit`. Пʼятої немає, і протухання самої черги dead-letter-ом не є.

`npm run demo:duplicate` — повтор викликається **падінням окремого процесу**
(`dist/crash-consumer.js` застосовує ефект і шле собі `SIGKILL` до `ack`).
`channel.close()` для цього не годиться: це коректне завершення, і requeue там
теж станеться, але падіння сервісу о 3-й ночі виглядає інакше — процес зникає,
ОС закриває сокет, брокер бачить обрив:

```
[crash-consumer] CHILD_READY
[crash-consumer] CHILD_DELIVERIES=1
[crash-consumer] CHILD_EFFECT=1
[crash-consumer] CHILD_EVENT=evt_order_placed_14
[crash-consumer] CHILD_CRASH
deliveries=2
effect=1
skipped=1
work=0
dlq=0
prefetch=10
```

Кожне демо само приводить стан до чистого (`purgeQueue` обох черг + прибирання
ефектів минулого прогону), само перевіряє інваріант і виходить із кодом ≠ 0,
якщо той порушено. Перевірено пʼятьма повторними прогонами кожного — 5 із 5
зелених.

### Секрети

`BROKER_URL` їде у сховище ДЗ-11 поруч із підключенням до бази, нового
env-файла під неї немає. Усі три демо-скрипти починаються з
`bash scripts/with-secrets.sh dev …` — рівно як `migrate` і `seed`. Аварійний
вхід `SKIP_VAULT=1` уже в обгортці.

На відміну від `DB_URL`, пароль у `BROKER_URL` дозволений: AMQP не має аналога
`DB_PASSWORD_FILE`, а `app:app` зі стенда секретом не є. Реальне значення для
проду живе у сховищі й у репозиторій не потрапляє — `.env.example` містить
лише дев-значення.

### Застереження, на яке варто мати відповідь

`dead-letter-strategy: at-least-once` без `overflow: reject-publish` мовчки не
працює: політика приймається, у `effective_policy_definition` вона є, а брокер
відкочується на `at-most-once` і повідомляє про це лише в лозі. Тут
використано дефолт, і для цього ДЗ його достатньо, але знати про це треба.

## Outbox та ідемпотентність (ДЗ-22)

ДЗ-19 публікувало подію одразу після `COMMIT`, і в README чесно стояло, що між
комітом і публікацією лишається вікно: процес, який упав саме там, лишає
замовлення без події. Тут це вікно закрите — а рахунок, який за цим приходить,
оплачений ідемпотентністю.

Спільного `COMMIT` між Postgres і RabbitMQ не існує, і жодний порядок викликів
його не створить. Тому замість двох записів у два менеджери ресурсів робиться
**один** запис у базу: бізнес-рядок і подія лягають однією транзакцією, а
назовні подію виносить окремий relay.

```bash
docker compose up -d --wait
npm run build
npm run migrate && npm run seed

npm run demo:outbox        # два запити з тим самим ключем -> одне замовлення
npm run demo:crash-write   # впав бізнес-запис -> подія не вийшла назовні
npm run demo:crash-relay   # впав службовий запис -> подія поїхала вдруге
```

### Схема

| Таблиця | Роль |
| --- | --- |
| `outbox` | `aggregate_type`, `aggregate_id`, `type`, `payload jsonb`, `created_at`, `published_at` (NULL = ще не винесено), `attempts` |
| `processed_messages` | inbox консюмера: `(message_id, consumer)` — позначка «це вже оброблено» |
| `idempotency_keys` | ключ ідемпотентності API-краю: `key` → `order_id` |

Під relay стоїть **частковий** індекс:

```sql
CREATE INDEX idx_outbox_unpublished ON outbox (created_at, id)
  WHERE published_at IS NULL;
```

Повний індекс по `published_at` розпухав би разом з історією винесених подій, а
цей накриває лише живий хвіст — рівно ті рядки, які relay і шукає.

Поля названі так, як їх читає Debezium Outbox Event Router, тож перехід на CDC
не переписує консюмерів. Дрібний шрифт: канонічні імена в Debezium — **без**
підкреслень (`aggregatetype`, `aggregateid`), і саме `aggregatetype` стоїть у
`route.by.field` за замовчуванням. Snake_case тут доведеться або перейменувати,
або явно задати `route.by.field` і `table.field.event.key`.

### Один COMMIT

`placeOrder()` — одна транзакція на все: claim ключа, декремент залишку,
списання балансу, замовлення з позиціями, задача post-processing і рядок
`outbox`.

```ts
return dataSource.transaction(async (manager) => {
  const claimed = await manager.query(`INSERT INTO idempotency_keys ("key") VALUES ($1)
                                       ON CONFLICT ("key") DO NOTHING RETURNING "key"`, [key]);
  if (claimed.length === 0) return replayOf(manager, key);

  const result = await checkoutInTransaction(manager, input);   // ДЗ-14, без змін
  const outboxId = await enqueueEvent(manager, toOrderPlacedEvent(result, input));
  …
});
```

Жодного `publish` усередині транзакції немає й бути не може: брокер не вміє
відкочуватись, тож кожен `ROLLBACK` лишав би назовні подію про замовлення,
якого не існує.

`dataSource.transaction()`, а не `pool.query('BEGIN')`: транзакція живе на
одному зʼєднанні з пулу, і `BEGIN` з `COMMIT`, відправлені через пул, поїхали б
різними зʼєднаннями — «одна транзакція» виявилась би фікцією.

У `payload` лежить спроектований контракт, який будує явна функція
`toOrderPlacedEvent(result, input)`. `{ ...order }` зробив би схему БД публічним
API, і перше ж перейменування колонки поїхало б у чужі сервіси. Інтеграційний
тест це й фіксує: у `payload.data` рівно шість полів, без `stock` і
`balance_cents`.

### Relay: SKIP LOCKED → publish → UPDATE

```sql
SELECT id, type, payload, attempts
  FROM outbox
 WHERE published_at IS NULL
 ORDER BY created_at, id
   FOR UPDATE SKIP LOCKED
 LIMIT $1
```

`SKIP LOCKED`, а не голий `FOR UPDATE`: без нього другий воркер не пропускає
зайняті рядки, а **стає в чергу** за ними. Дублів тоді теж нуль — ціною нуля
паралельності: воркери шикуються в шеренгу й чекають один одного.

Умова — `published_at IS NULL`, а не курсор по `id`. Курсор пропускав би рядки:
`bigserial` видає номер на `nextval`, а видимим рядок стає лише на `COMMIT`, тож
транзакція з меншим id може закомітитись пізніше за сусідню з більшим — і «усе,
що більше за останній оброблений», її не побачить.

Polling, а не `LISTEN/NOTIFY`: сповіщення не переживає рестарт слухача, і
пропущений `NOTIFY` означав би непідібрану подію. Опитування дешеве рівно
завдяки частковому індексу.

Про порядок доставки чесно: **жоден `ORDER BY` тут його не гарантує**.
`SKIP LOCKED` розкидає рядки між воркерами, тож сортування задає лише порядок
*вибірки*. Якщо порядок потрібен, він існує тільки в межах ключа
партиціонування — для цього домену він не потрібен, і тому не робиться.

### Чому не можна поміняти місцями publish і UPDATE published_at

Спокуса зрозуміла: спершу позначити рядок винесеним, потім публікувати — і
дубль нібито зникає. Насправді міняється не наявність проблеми, а її рід.

У порядку **publish → UPDATE** найгірше, що буває, — повторна публікація:
процес помер після `publish`, `published_at` лишився `NULL`, наступний прохід
винесе подію вдруге.

У порядку **UPDATE → publish** найгірше, що буває, — **втрата**: рядок уже
позначено винесеним, `publish` не вдався, і наступний прохід його вже не
підбере, бо він більше не підходить під `published_at IS NULL`.

Вибір тут не між «добре» і «погано», а між дублем і втратою. Дубль лікується
дедуплікацією на консюмері. Втрата не лікується нічим: події, якої немає ні в
черзі, ні в списку невинесених, не існує.

І окремо, чому дедуп обовʼязковий незалежно від акуратності relay: **помилка
`publish` не означає, що повідомлення не доставлено**. Загубитись могла
відповідь брокера, а саме повідомлення вже лежить у черзі. «Зловив помилку →
відкотив → усе чисто» — ілюзія.

### Три рівні ідемпотентності

| Рівень | Де | Чим |
| --- | --- | --- |
| 1. Природний ключ | ефект консюмера | `INSERT INTO picking_tasks … ON CONFLICT ("eventId") DO NOTHING` |
| 2. Inbox | консюмер | рядок у `processed_messages (message_id, consumer)` — **у тій самій транзакції**, що й ефект |
| 3. Ключ ідемпотентності | API-край, `POST /checkout` | `Idempotency-Key` → `idempotency_keys`, claim у бізнес-транзакції |

Рівень 1 — найдешевша коректна форма: операція «вставити рядок із цим ключем»
ідемпотентна за побудовою, на відміну від `UPDATE qty = qty - 1`, який на другій
доставці зняв би вдвічі. Рівень 2 потрібен тому, що природний ключ є не в
кожного ефекту: «надіслати лист» через `ON CONFLICT` не виразиш.

Критичне в рівні 2 — **одна транзакція** на позначку й ефект. Позначити в Redis,
а ефект записати в Postgres — це той самий dual write, від якого ми тікали,
тільки перенесений на консюмера.

Рівень 3 живе на справжньому HTTP-краю: `POST /checkout` зі спеки ДЗ-09.
Ключ ідентифікує **намір**, а не тіло — хеш тіла схлопнув би два легітимні
однакові замовлення в одне. Перевірено тестом: той самий ключ дає те саме
замовлення, інший ключ із тим самим тілом — друге.

Чому окремий ендпоїнт, а не `POST /orders`: той із ДЗ-09 лишається in-memory
стабом контракту (на ньому стоять e2e- і contract-тести ДЗ-16 та SSE-потік
ДЗ-18), а тут потрібні справжні рядки Postgres — інакше нема про яку
транзакційність говорити. Ключ там теж є, але він живе в памʼяті процесу: не
переживає рестарт і не існує між репліками. Цей — переживає.

### Числа трьох прогонів

`npm run demo:outbox` — два справжні HTTP-запити з тим самим `Idempotency-Key`
у піднятий застосунок:

```
[demo] запит 1: order_id=51 replay=false
[demo] запит 2: order_id=51 replay=true
requests=2
orders=1
outbox=1
published=1
deliveries=1
effect=1
processed=1
```

`npm run demo:crash-write` — транзакція валиться **після** вставки рядка в
outbox. Зникають обидва рядки; relay запускається попри все і не знаходить, що
виносити:

```
[demo] змодельований збій бізнес-запису ПІСЛЯ вставки рядка в outbox
write-failed=1
orders=0
outbox=0
published=0
deliveries=0
effect=0
```

`npm run demo:crash-relay` — **серце ДЗ**. Relay помирає рівно між `publish` і
`UPDATE published_at`:

```
[demo] змодельоване падіння relay між publish і UPDATE published_at
[demo] невинесених подій після падіння: 1
published=2
deliveries=2
applied=1
effect=1
processed=1
```

Форма падіння тут — **змодельований обрив**: виняток із хука
`betweenPublishAndMark`, через який транзакція relay відкочується рівно в тій
точці, де справжній процес отримав би `SIGKILL`. Наслідок для бази той самий —
`published_at` лишається `NULL`, — але демо детерміноване і не залежить від
того, чи встиг дочірній процес дописати stdout. Критерій перевіряє наслідок, а
не спосіб; обидві форми легальні. (Форму з реальним `kill -9` у цьому
репозиторії теж видно — `demo:duplicate` із ДЗ-19 робить саме так.)

Кожне демо само приводить стан до чистого, друкує ключ=число і виходить із
кодом ≠ 0, якщо інваріант порушено. Перевірено пʼятьма повторними прогонами
кожного — 5 із 5 зелених.

Те саме, але в CI і без брокера, лежить у `test/integration/outbox.spec.ts`:
publisher підмінено лічильником, бо всі інваріанти цього ДЗ — властивості
записів у базі, і перевіряти їх треба базою.

### Чим це НЕ є

Exactly-once доставки не існує — це задача двох генералів. Існує at-least-once
доставка плюс ідемпотентний ефект, і разом вони дають exactly-once **результат**.
`demo:crash-relay` — рівно те місце, де це видно очима: `deliveries=2` при
`effect=1`. Kafka дає EOS усередині себе (read-process-write між своїми
топіками); щойно на іншому кінці твоя база — гарантія знову зводиться до твого
ключа дедуплікації.

### Як чиститься outbox

Таблиця росте, і росте разом із нею той самий частковий індекс, від якого
залежить relay. Винесені рядки — це історія, а не робочий набір, тож план
такий: нічний `DELETE FROM outbox WHERE published_at < now() - interval '7 days'`
поруч із бекапом ДЗ-15 (сім днів — щоб було з чим звіритись при розборі
інциденту). На обсягах, де `DELETE` почне заважати, це перетворюється на
щомісячне партиціонування `outbox` за `created_at` і `DROP` старої партиції —
`DROP PARTITION` не лишає за собою роботи для autovacuum, на відміну від
масового `DELETE`.

### Межа, яку це ДЗ не переходить

Щілина між «позначили оброблене» і «застосували ефект» закрита — вони в одній
транзакції. Наступний крок лінії (ДЗ-23) кладе поверх цієї ж події Redis і
чергу BullMQ, і там окремо варто памʼятати: розподілений лок **не замінює**
ідемпотентність. Лок зменшує ймовірність одночасної обробки, але не робить
повторну обробку безпечною — це різні властивості.

## Redis: кеш, сесії, ліміти, черга (ДЗ-23)

Чотири різні задачі, які в бекенді все одно доводиться робити, і одна спільна
думка під ними: **Redis не робить систему правильною — він робить її швидкою.**
Де це не так, окремо сказано нижче.

```bash
docker compose up -d --wait
npm run build
npm run migrate && npm run seed

npm run demo:cache       # лавина на холодний ключ -> один похід у базу
npm run demo:session     # сесія в Redis, TTL подовжується при активності
npm run demo:ratelimit   # два поди ділять один ліміт
npm run demo:queue       # ретраї, дедуп по jobId, планувальник
```

### Два інстанси Redis — не примха

| Інстанс | Порт | Політика | Хто живе |
| --- | --- | --- | --- |
| `redis-cache` | 6390 | `maxmemory 256mb` + `allkeys-lru` | кеш карток товару |
| `redis-queue` | 6391 | `noeviction` + AOF `everysec` | черга BullMQ і сесії |

Кешу `maxmemory` з витісненням потрібні обовʼязково. Стоковий Redis має
`maxmemory 0` і `noeviction` — такий кеш не деградує повільно, він у якийсь
момент починає кидати `OOM command not allowed when used memory > 'maxmemory'`
**на запис**, і разом із кешем падає запит користувача. (Тому `cacheSet()` тут
ще й обгорнутий: кеш, який роняє запити, — це не кеш.)

Документація BullMQ вимагає рівно протилежного: черга «cannot work properly if
Redis evicts keys arbitrarily», тобто `noeviction`. `maxmemory-policy` —
налаштування **процесу**, а не бази всередині нього, тож `SELECT 1` ці дві
вимоги не розводить. Звідси дві коробки, а не два номери БД. Підключений не
туди BullMQ сам пише в лог `IMPORTANT! Eviction policy is allkeys-lru`.

Сесії лежать у черговому інстансі, не в кеші: `allkeys-lru` колись викинув би
сесію під тиском памʼяті, і вийшло б розлогінення, якого ніхто не може
відтворити — ключ зник не тому, що протух, а тому, що був найменш популярним у
вибірці з пʼяти. Третю коробку не підіймаю: у сесій і черги однакова вимога
«нічого не викидати самочинно».

Порти 6390/6391 навмисно не з діапазону лекції (22300-22399) — щоб цей стек і
стек лекції можна було ганяти паралельно.

### Кеш: джитер і single-flight

Кешується «важке» читання домену — картка товару з рейтингом, залишком і
продажами: три агрегати по трьох таблицях, з яких `order_items` росте разом з
історією замовлень.

`TTL = 300 + random(0..60)` секунд. Джитер не косметика: без нього ключі,
прогріті одним циклом, протухають **в одну секунду** й дають stampede у
хвилину, коли ніхто нічого не змінював. У прогоні нижче 60 прогрітих ключів
дали 41 різне значення TTL; без джитера було б рівно одне.

TTL ставиться **завжди**, навіть там, де є явна інвалідація на записі:
інвалідація — це додатково, а не замість. Ключ без TTL, який інвалідація
колись проґавила, лишається в кеші назавжди.

Лавину тримає single-flight лок: перший бере `SET lock:<key> <token> NX PX`,
іде в базу й наповнює кеш; решта чекає й перечитує кеш.

Знімається лок **порівнянням токена**, а не голим `DEL`:

```lua
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
```

Голий `DEL` знімає чужий лок: між «мій лок протух» і «я його знімаю»
вміщається чужий `SET NX`. `DELEX … IFEQ <token>` робив би те саме одним
викликом, але він зʼявився аж у Redis 8.4, а стенд тут на 7.x — Lua працює на
будь-якій версії.

### Що станеться, якщо stampede-лок зламається

Нічого страшного — і це головне, що варто розуміти про цей лок.

Він **оптимізація**, а не захист інваріанта. Зламався — замість одного походу
в базу буде кілька: кілька зайвих мілісекунд навантаження й кілька центів. Дані
при цьому лишаються коректними, бо читання ідемпотентне за природою: два
однакові `SELECT` дають два однакові результати.

Саме тому тут достатньо compare-and-delete і **не** потрібен fencing token.
Класична діра розподіленого лока нікуди не зникла: процес завмер (GC, page
fault, переїзд контейнера), лок протух, його взяв інший — а ти прокинувся
впевнений, що лок досі твій. Перевірка «а чи мій ще лок?» перед записом не
рятує: пауза може статися між перевіркою і записом. Закриває це лише монотонний
fencing token, який перевіряє саме сховище.

Але якби той самий `SET NX PX` стояв у ролі захисту **бізнес-інваріанта** —
«тільки один процес списує гроші з цього рахунку» — ціною поломки був би
зіпсований стан, а не кілька центів. Саме тому в цьому проєкті такі інваріанти
локом не захищені: списання балансу й декремент залишку тримає транзакція
Postgres з атомарним `UPDATE … WHERE stock >= $n` (ДЗ-14), а не Redis.

### Сесії: rolling TTL

Сесія читається на кожному запиті й на кожному ж продовжується — `HGETALL` +
`EXPIRE` однією транзакцією. Без продовження активного користувача викидало б
посеред роботи рівно через TTL від логіну, незалежно від того, що він увесь цей
час щось робив.

Сховище — Redis, а не памʼять процесу: після рестарту процесу сесія має жити, і
між двома подами вона має бути тією самою. Зберігається хешем, а не рядком, щоб
окремі поля (`lastSeenAt`, `requests`) оновлювались без перечитування всього
обʼєкта.

### Ліміт: ковзне вікно одним Lua-скриптом

Питання при виборі моделі завжди одне: **дозволяємо сплеск чи ні?**

Фіксоване вікно сплеск дозволяє, і не трохи: 5 запитів о 12:00:59 і ще 5 о
12:01:00 — це 10 запитів за 320 мілісекунд при ліміті 5. Це не баг реалізації,
це властивість моделі, і цілять саме в неї. Token bucket дозволяє сплеск
свідомо — він правильний там, де сплеск **закономірний** (пакетна синхронізація
клієнта). Тут ми обмежуємо чужих, а не своїх, тож узято **ковзне вікно**: рівно
N за будь-які останні W секунд, без винятків на межі.

Увесь лімітер — один Lua-скрипт, і тут атомарність є вимогою **коректності**, а
не оптимізацією: між `ZCARD` і `ZADD` встигає влізти інший под, і ліміт протікає
рівно там, де він найпотрібніший — під навантаженням.

Лічильник живе в Redis, а не в памʼяті процесу. На памʼяті два поди пропустили б
`2 × limit`, а `status` лишився б 200 — і жоден локальний тест цього не
побачить, бо локально под один. Те саме стосується `@nestjs/throttler` із його
дефолтним сховищем: це найчастіший спосіб здати цей пункт «наполовину».
Перевищення віддає `429` і `Retry-After` (мінімум 1 секунда: «0» означало б
«пробуй просто зараз», а слот ще не звільнився).

### Черга: ретраї, дедуп, планувальник

Черга під роботу, якій немає місця в HTTP-запиті — перерахунок рейтингу товару
після замовлення.

- `attempts: 3`, `backoff: { type: 'exponential', delay: 200, jitter: 0.5 }`.
  Джитер розводить ретраї в часі: без нього всі впалі задачі бʼють по тому
  самому ресурсу, який щойно не витримав.
- `jobId` для дедуплікації — і **не** `removeOnComplete: true` разом із ним:
  видалена задача більше не вважається дублікатом, тобто прибирання вимикає
  дедуп. Тут стоїть `removeOnComplete: { age: 3600 }` — запас, більший за вікно,
  у якому можливий повтор.
- `upsertJobScheduler`, а не `add({ repeat })`: repeat-API і
  `getRepeatableJobs` у BullMQ 6 прибрано. Upsert, а не add, — інакше кожен
  рестарт процесу плодив би дублікати планувальників; демо робить два upsert
  поспіль і показує, що планувальник лишився один.
- `maxRetriesPerRequest: null` на зʼєднанні воркера — вимога BullMQ: інакше
  ioredis при розриві кине виняток, і воркер зламається замість того, щоб
  дочекатись Redis. Для зʼєднання кеша, навпаки, падати швидко правильно.

### Числа прогонів

```
# npm run demo:cache
[demo] кеш-інстанс: maxmemory-policy=allkeys-lru, maxmemory=33554432
[demo] TTL прогрітих ключів: від 301 до 359
cache-lru=1
cache-maxmemory=1
warmed=60
ttl-distinct=41
concurrent=25
db-calls=1
db-calls-warm=0
```

25 одночасних читань щойно зниклого ключа дали **один** похід у базу, наступні
100 читань теплого кеша — **жодного**. `db-calls` рахує сам репозиторій, у тому
рядку, де відправляється SQL, а не «скільки разів я викликав функцію».

```
# npm run demo:session
[demo] TTL одразу після створення: 60s
[demo] TTL після паузи: 58s
[demo] TTL після 4 запитів: 60s
requests=4
sessions=1
in-redis=1
ttl-renewed=1
```

Пауза між запитами справжня (1,5 с): без неї TTL не встиг би просісти, і
«подовження» було б непомітним навіть на правильній реалізації. Наявність ключа
перевіряє окреме зʼєднання-спостерігач, яке нічого не знає про `SessionStore`.

```
# npm run demo:ratelimit
[demo] подів: 2, ліміт: 5 за вікно
[demo] пропущено 5, відкинуто 7
instances=2
limit=5
requests=12
allowed=5
blocked=7
status=429
retry-after=1
```

Два незалежні екземпляри лімітера з власними зʼєднаннями — модель двох подів.
Спільне в них рівно одне: ключ у Redis. `allowed=5` при `limit=5` і є доказом:
на лічильнику в памʼяті було б 10.

```
# npm run demo:queue
[queue] спроба 1
[queue] спроба 2
[queue] спроба 3
[demo] після 2 add з jobId=rating:1:…: у черзі 1
[demo] планувальників після двох upsert: 1
queue-noeviction=1
attempts=3
completed=1
added=2
queued=1
schedulers=1
scheduled-runs=6
```

Кожне демо само приводить стан до чистого (`SCAN`+`DEL` свого простору імен,
`obliterate` черги), друкує `ключ=число` і виходить із кодом ≠ 0, якщо інваріант
порушено. По пʼять повторних прогонів кожного — 5 із 5 зелених.

### Чого тут свідомо немає

Раннього оновлення (probabilistic early expiration) — воно корисне, але на
**холодному** ключі не рятує взагалі, а демо показує саме холодний старт.
Витіснення конкретного ключа теж не перевіряється: LRU в Redis наближений
(`maxmemory-samples` за замовчуванням 5, жертва обирається з вибірки, а не
глобально), тож питання «а чи зник саме `card:v1:42`?» не має стабільної
відповіді — і будувати на ньому критерій означало б отримати тест, який падає
через раз.

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
