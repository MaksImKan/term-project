import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool, PoolClient } from 'pg';
import { DataSource } from 'typeorm';
import { Order, OrderItem, Product, Task, User } from '../../src/entities';
import { migrations } from '../../src/migrations';

/**
 * Один Postgres на файл тестів — піднімається з коду через testcontainers.
 *
 * Чому не мок і не спільна «тестова база на машині»: констрейнти, генеровані
 * колонки, GIN-індекс, JOIN-и й агрегати — усе це поведінка БД, а не коду.
 * Контейнер дає справжній Postgres 16 тієї ж версії, що в проді, і гарантовано
 * чисту схему: міграції застосовуються тут же, з коду.
 *
 * Якщо в оточенні вже є TEST_DATABASE_URL (або DATABASE_URL), контейнер не
 * підіймається, а тести йдуть у вказану базу. Це потрібно для CI із
 * service-контейнером Postgres і для середовищ без доступу до реєстрів образів;
 * у звичайному локальному прогоні працює саме testcontainers.
 */
export const POSTGRES_IMAGE = 'postgres:16-alpine';

export interface TestDatabase {
  uri: string;
  pool: Pool;
  /** Як саме піднялася база — видно у виводі тесту. */
  source: 'testcontainers' | 'env';
  stop(): Promise<void>;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const external = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

  let container: StartedPostgreSqlContainer | undefined;
  let uri: string;
  let source: TestDatabase['source'];

  if (external) {
    uri = external;
    source = 'env';
  } else {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('marketplace_test')
      .withUsername('test')
      .withPassword('test')
      .start();
    uri = container.getConnectionUri();
    source = 'testcontainers';
  }

  await applyMigrations(uri);

  const pool = new Pool({ connectionString: uri, max: 6 });

  return {
    uri,
    pool,
    source,
    async stop() {
      // Незакритий пул = jest висить назавжди. Діагностика, якщо колись
      // станеться: npx jest --detectOpenHandles.
      await pool.end();
      await container?.stop();
    },
  };
}

/** Схема створюється тими самими міграціями, що йдуть у прод. */
export async function applyMigrations(uri: string): Promise<void> {
  const ds = new DataSource({
    type: 'postgres',
    url: uri,
    synchronize: false,
    logging: false,
    entities: [User, Product, Order, OrderItem, Task],
    migrations,
  });

  await ds.initialize();
  try {
    await ds.runMigrations({ transaction: 'all' });
  } finally {
    await ds.destroy();
  }
}

/**
 * Оточення для підняття СПРАВЖНЬОГО застосунку в тестах.
 *
 * Тонкість, через яку інакше впали б e2e: zod-схема застосунку (ДЗ-11) приймає
 * DB_URL лише БЕЗ пароля — пароль за конвенцією проєкту живе окремо, у
 * файлі-секреті. А testcontainers віддає URI з паролем усередині. Тому тут URI
 * розбирається: логін/хост/база йдуть у DB_URL, пароль — у тимчасовий файл,
 * шлях до якого кладеться в DB_PASSWORD_FILE. Тобто e2e проходить рівно тим
 * самим шляхом конфігурації, що й прод, а не в обхід нього.
 */
export function appEnvFor(uri: string): { DB_URL: string; DB_PASSWORD_FILE: string } {
  const parsed = new URL(uri);
  const password = decodeURIComponent(parsed.password);
  parsed.password = '';

  const file = path.join(
    mkdtempSync(path.join(tmpdir(), 'marketplace-e2e-')),
    'db_password',
  );
  writeFileSync(file, password, { mode: 0o600 });

  return {
    DB_URL: `postgres://${parsed.username}@${parsed.hostname}:${parsed.port || 5432}${parsed.pathname}`,
    DB_PASSWORD_FILE: file,
  };
}

/**
 * Ізоляція integration-тестів: транзакція + ROLLBACK.
 *
 * Кожен тест отримує власний клієнт із відкритою транзакцією; після тесту —
 * ROLLBACK. База не змінюється взагалі, тому порядок тестів не має значення,
 * чистити нічого не треба, і повторний прогін suite завжди зелений.
 *
 * Обмеження, про яке треба знати: усе, що відбувається в транзакції, не видно
 * іншим зʼєднанням. Тести справжньої конкурентності (два паралельних checkout)
 * так писати не можна — для них є окремі демо у src/demo-*.ts, які працюють із
 * закомічених даних.
 */
export function useRollbackTransaction(getPool: () => Pool): () => PoolClient {
  let client: PoolClient;

  beforeEach(async () => {
    client = await getPool().connect();
    await client.query('BEGIN');
  });

  afterEach(async () => {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  });

  return () => client;
}

/**
 * Ізоляція e2e-тестів: TRUNCATE між кейсами.
 *
 * Тут ROLLBACK не підходить у принципі: застосунок ходить у базу своїм пулом,
 * і транзакція тесту для нього невидима. Тому після кожного кейсу приводимо
 * базу в порожній стан — одним висловом, з RESTART IDENTITY, щоб id не «текли»
 * між тестами, і CASCADE, бо на orders посилаються order_items і tasks.
 */
export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE tasks, order_items, orders, products, users RESTART IDENTITY CASCADE');
}
