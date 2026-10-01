/**
 * Мінімальний контракт «чогось, що вміє query()».
 *
 * Саме через нього репозиторії приймають і `pg.Pool` (прод, через
 * DatabaseService), і `pg.PoolClient` (тести). Це не абстракція «про запас»:
 * без неї стратегія ізоляції «транзакція + ROLLBACK» не підключилася б —
 * транзакція живе на ОДНОМУ клієнті, і репозиторій мусить ходити саме в нього,
 * а не брати довільне зʼєднання з пулу.
 */
export interface Queryable {
  query<T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

/**
 * TypeORM і pg повертають для UPDATE/DELETE різні форми результату, тож усі
 * репозиторії ходять через pg-подібний Queryable і працюють з `rows` напряму.
 */
export class RepositoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RepositoryError';
  }
}

/** Код SQLSTATE із помилки драйвера pg, якщо він там є. */
export function sqlstateOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Коди, які читаються у тестах і в обробці помилок. */
export const SQLSTATE = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  NOT_NULL_VIOLATION: '23502',
} as const;
