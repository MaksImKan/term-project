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
