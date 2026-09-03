# Marketplace API — курсовий проєкт

NestJS + `express-openapi-validator` (ДЗ-09) та керована конфігурація з ротацією
секретів (ДЗ-11). Розділ [Configuration](#configuration) — про змінні середовища,
запуск і ротацію пароля БД без рестарту.

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
| `docker-compose.yml`, `db/init.sql` | Локальний Postgres + сіди каталогу                         |
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

| Змінна | Тип / значення | Обовʼязкова | Типово | Призначення |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | `development` \| `test` \| `production` | ні | `development` | Режим роботи застосунку |
| `PORT` | integer 1..65535 | ні | `3000` | HTTP-порт |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` | ні | `info` | Рівень логування |
| `DB_URL` | `postgres://<user>@<host>:<port>/<db>` | **так** | — | DSN Postgres **без пароля** |
| `DB_PASSWORD_FILE` | шлях | ні | `./secrets/db_password` | Файл-секрет із паролем БД |
| `DB_POOL_MAX` | integer 1..100 | ні | `10` | Максимум зʼєднань у пулі |
| `DB_CONNECTION_TIMEOUT_MS` | integer 100..60000 | ні | `5000` | Таймаут отримання зʼєднання |
| `DB_SSL` | `true` \| `false` | ні | `false` | TLS до Postgres |
| `VALIDATE_RESPONSES` | `true` \| `false` | ні | `true` | Валідація відповідей проти OpenAPI |
| `DEFAULT_CURRENCY` | ISO 4217, 3 символи | ні | `UAH` | Валюта замовлення за замовчуванням |
| `DEFAULT_PAGE_LIMIT` | integer 1..100 | ні | `20` | Розмір сторінки cursor-пагінації |

Числа описані через `z.coerce.number()`, а не `z.number()`: усе, що приходить з env, —
рядок. Булеві значення — через явний `z.enum([...]).transform(...)`, бо
`z.coerce.boolean()` перетворив би рядок `"false"` на `true`.

`DB_URL` не містить пароля навмисно: схема відхилить DSN із паролем усередині.

### Запуск

```bash
npm install
cp .env.example .env          # реальні значення; .env у .gitignore
npm run secrets:init          # створює secrets/db_password (стартове значення)
npm run db:up                 # Postgres у docker compose + init.sql (сіди каталогу)
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
  (`POSTGRES_PASSWORD_FILE: /run/secrets/db_password`), а не з хардкоду в `init.sql`.
- `npm start` має бути не-watch, інакше перевірка fail-fast механічно не проходить.
- Для перевірки fail-fast треба тимчасово прибрати `.env` — інакше `dotenv` тихо підхопить
  змінну з файла: `mv .env /tmp && env -u DB_URL npm start; echo $?; mv /tmp/.env .`
- TypeScript + `pg` потребують `@types/pg` у devDependencies, інакше `tsc` падає з TS7016.

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
