/**
 * Retry-обгортка для транзакцій, які Postgres відхилив через конфлікт
 * сериалізації.
 *
 * ── Чому саме два коди ────────────────────────────────────────────────────
 *
 *   40001 serialization_failure — «could not serialize access due to concurrent
 *         update». Postgres під REPEATABLE READ / SERIALIZABLE побачив, що
 *         рядок змінився після початку транзакції, і відмовився дати результат,
 *         який не відповідав би жодному послідовному виконанню.
 *   40P01 deadlock_detected — дві транзакції взяли локи у різному порядку;
 *         Postgres обрав жертву й відкотив її, щоб розірвати цикл.
 *
 * Спільне в них одне: транзакція не виконалась, але дані цілі, і ПОВТОР має
 * усі шанси пройти — конфлікт залежав від збігу в часі, а не від даних.
 *
 * Будь-яка інша помилка так не влаштована. `23505 unique_violation`,
 * `23514 check_violation`, `23503 foreign_key_violation` означають, що дані не
 * такі, як думав код: повтор дасть ту саму помилку, лише з затримкою.
 * `57014 query_canceled`, `53300 too_many_connections` — проблема інфраструктури,
 * її лікує не повтор транзакції, а бекофф на рівні вище. А помилка в SQL
 * (`42601 syntax_error`) від повторів не зникає взагалі. Тому ловимо рівно два
 * коди, а решту прокидаємо нагору — тихий повтор чужої помилки перетворює баг
 * на загадкове «іноді працює».
 *
 * ── Чому повторюється ВСЯ транзакція ──────────────────────────────────────
 *
 * Повторюється транзакція з початку, включно з читаннями: у новій транзакції
 * новий снапшот, і рішення треба приймати за свіжими даними. Повторити тільки
 * запис зі старим прочитаним значенням — це і є lost update, просто виглядає
 * як «retry».
 */

/** Коди, які варто повторювати. Решта — не наша справа. */
const RETRYABLE_CODES = new Set(['40001', '40P01']);

export interface RetryAttemptLog {
  attempt: number;
  code: string;
  message: string;
  delayMs: number;
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  label?: string;
  onRetry?: (log: RetryAttemptLog) => void;
}

export interface RetryOutcome<T> {
  value: T;
  attempts: number;
  retries: RetryAttemptLog[];
}

export function isRetryableError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && RETRYABLE_CODES.has(code);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Виконує `work` і повторює його цілком, якщо Postgres віддав 40001 / 40P01.
 * Затримка — експоненційна з джитером: без випадкової складової ті самі дві
 * транзакції прокинулись би одночасно й зіштовхнулись знову.
 */
export async function withRetry<T>(
  work: () => Promise<T>,
  options: RetryOptions = {},
): Promise<RetryOutcome<T>> {
  const maxAttempts = options.maxAttempts ?? 6;
  const baseDelayMs = options.baseDelayMs ?? 15;
  const retries: RetryAttemptLog[] = [];

  for (let attempt = 1; ; attempt += 1) {
    try {
      const value = await work();
      return { value, attempts: attempt, retries };
    } catch (error) {
      if (!isRetryableError(error) || attempt >= maxAttempts) throw error;

      const code = String((error as { code?: unknown }).code);
      const delayMs = Math.round(
        baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random()),
      );
      const log: RetryAttemptLog = {
        attempt,
        code,
        message: (error as Error).message.split('\n')[0],
        delayMs,
      };
      retries.push(log);
      options.onRetry?.(log);

      await sleep(delayMs);
    }
  }
}
