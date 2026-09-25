# Marketplace API — курсовий проєкт

NestJS + `express-openapi-validator` (ДЗ-09), керована конфігурація з ротацією
секретів (ДЗ-11), дата-шар на Postgres з індексами та повнотекстовим пошуком (ДЗ-12)
TypeORM поверх цієї схеми — entities, міграції, N+1 (ДЗ-13) — і конкурентні
транзакції: checkout без oversell, воркер-пул на `SKIP LOCKED`, retry (ДЗ-14).

* [Grading](#grading) — блок для грейдера: свіжий клон, чиста БД, без сховища
* [Configuration](#configuration) — змінні середовища, запуск, ротація пароля БД
* [Дата-шар](#дата-шар-дз-12) — схема, seed на 100k+, `EXPLAIN` до і після індексів
* [ORM-шар](#orm-шар-дз-13) — entities, міграції, N+1, Repository проти QueryBuilder
* [Конкурентність](#конкурентність-дз-14) — транзакційний checkout, SKIP LOCKED, retry

## Grading

Блок для грейдера: свіжий клон, чиста БД, без доступу до сховища секретів.
Працює як є, без правок файлів.

```bash
docker compose up -d --wait
export DATABASE_URL=postgres://marketplace:dev_password_0@127.0.0.1:5432/marketplace
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
```

`package.json` лежить у корені репозиторію, тому жодного `cd` перед цими
командами не потрібно.

Замість єдиного `DATABASE_URL` можна експортувати розібрані змінні — `data-source.ts`
розуміє обидві форми:

```bash
export DB_HOST=127.0.0.1 DB_PORT=5432 DB_USER=marketplace DB_PASSWORD=dev_password_0 DB_NAME=marketplace
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
