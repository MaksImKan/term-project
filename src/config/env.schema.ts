import { z } from 'zod';

/**
 * ЄДИНЕ джерело правди про конфігурацію застосунку.
 *
 * Потік:  process.env  ->  ця zod-схема (fail-fast)  ->  ConfigService<Env, true>  ->  код
 *
 * Правила:
 *  - усе, що приходить з env, є РЯДКОМ, тож числа описуємо через z.coerce.number(),
 *    а не z.number() (інакше "3000" ніколи не пройде валідацію);
 *  - z.coerce.boolean() використовувати НЕ можна: Boolean("false") === true,
 *    тому для булевих значень є явний zBool();
 *  - паролів тут немає й бути не може: пароль БД читається з файла-секрета,
 *    шлях до якого задає DB_PASSWORD_FILE.
 */

/** Булеве значення з env: приймає рядки, повертає boolean. */
const zBool = (defaultValue: 'true' | 'false') =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(defaultValue)
    .transform((v) => v === 'true' || v === '1');

/**
 * Ключі цього об'єкта — контракт .env.example (див. scripts/check-env-example.mjs).
 * Кожен ключ пишемо з відступом у 2 пробіли: скрипт звірки читає саме цей блок.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  DB_URL: z
    .string({ required_error: 'обовʼязкова змінна: DSN Postgres без пароля' })
    .min(1, 'не може бути порожнім')
    .regex(
      /^postgres(ql)?:\/\/[^:@\s]+@[^\s/]+\/[^\s?]+/,
      'очікується postgres://<user>@<host>:<port>/<database> БЕЗ пароля (пароль живе у файлі DB_PASSWORD_FILE)',
    ),
  DB_PASSWORD_FILE: z.string().min(1).default('./secrets/db_password'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
  DB_SSL: zBool('false'),
  // Адреса брокера (ДЗ-19). Приходить зі сховища тією самою обгорткою, що й
  // підключення до бази, — нового env-файла для неї не заводимо.
  //
  // Тут, на відміну від DB_URL, пароль у DSN дозволений свідомо: AMQP не має
  // аналога DB_PASSWORD_FILE, а креденшели локального стенда (app:app із
  // docker-compose.yml) секретом не є. Реальне значення для проду живе у
  // сховищі ДЗ-11 і в репозиторій не потрапляє.
  BROKER_URL: z
    .string()
    .regex(
      /^amqps?:\/\/[^\s]+$/,
      'очікується amqp://<user>:<pass>@<host>:5672 (5672 — AMQP; 15672 — вебморда, не протокол)',
    )
    .default('amqp://app:app@127.0.0.1:5672'),
  // ── Redis (ДЗ-23) ─────────────────────────────────────────────────────────
  // Два інстанси, і це не примха: кешу потрібні maxmemory + allkeys-lru, а
  // документація BullMQ вимагає протилежного — noeviction, бо черга «cannot
  // work properly if Redis evicts keys arbitrarily». maxmemory-policy одна на
  // весь процес, і SELECT 1 її не розводить, тож потрібні саме дві коробки.
  REDIS_URL: z
    .string()
    .regex(/^rediss?:\/\/[^\s]+$/, 'очікується redis://<host>:<port>')
    .default('redis://127.0.0.1:6390'),
  // Сюди ж, у чергову коробку, кладемо сесії: у кеш-інстансі allkeys-lru
  // колись викинув би сесію, і вийшло б розлогінення, якого ніхто не може
  // відтворити.
  REDIS_QUEUE_URL: z
    .string()
    .regex(/^rediss?:\/\/[^\s]+$/, 'очікується redis://<host>:<port>')
    .default('redis://127.0.0.1:6391'),
  // Базовий TTL кеша, секунди. Джитер додається зверху — див. CACHE_TTL_JITTER_S.
  CACHE_TTL_S: z.coerce.number().int().min(1).max(86_400).default(300),
  // Розкид джитера, секунди. Без нього ключі, прогріті одним циклом, протухнуть
  // в одну секунду й дадуть stampede на порожньому місці.
  CACHE_TTL_JITTER_S: z.coerce.number().int().min(10).max(3_600).default(60),
  // Ліміт запитів на вікно і довжина вікна в секундах.
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10_000).default(5),
  RATE_LIMIT_WINDOW_S: z.coerce.number().int().min(1).max(3_600).default(1),

  // Скільки повідомлень брокер віддає споживачу наперед (ДЗ-19).
  // Стеля 2000 — жорстке обмеження quorum-черг; 0 (дефолт брокера) означає
  // «без ліміту» і тут заборонений схемою.
  BROKER_PREFETCH: z.coerce.number().int().min(1).max(2000).default(10),
  VALIDATE_RESPONSES: zBool('true'),
  DEFAULT_CURRENCY: z.string().length(3, 'код валюти ISO 4217 — рівно 3 символи').default('UAH'),
  DEFAULT_PAGE_LIMIT: z.coerce.number().int().min(1).max(100).default(20),
});

/** Типізована конфігурація. Використовується як ConfigService<Env, true>. */
export type Env = z.infer<typeof envSchema>;

/** Список ключів схеми — знадобиться скрипту звірки й тестам. */
export const ENV_KEYS = Object.keys(envSchema.shape) as (keyof Env)[];

/**
 * validate() викликається у ConfigModule.forRoot ДО побудови DI-графа.
 * Тому кидаємо ОДИН Error зі списком УСІХ зламаних змінних одразу —
 * інакше розробник виправлятиме їх по одній, перезапускаючи процес.
 */
export function validate(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);

  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const name = issue.path.join('.') || '(root)';
      return `  - ${name}: ${issue.message}`;
    });

    throw new Error(
      [
        `Некоректна конфігурація середовища (${problems.length} проблем(и)).`,
        ...problems,
        '',
        'Звірся з .env.example — там перелічені всі змінні застосунку.',
      ].join('\n'),
    );
  }

  return parsed.data;
}
