import type { AddressInfo } from 'node:net';
import { ExpressAdapter, NestExpressApplication } from '@nestjs/platform-express';
import { NestFactory } from '@nestjs/core';
import type { DataSource } from 'typeorm';
import { NEST_APP_OPTIONS, configureApp } from '../bootstrap';
import { countProcessed } from './inbox';

/**
 * Спільна частина трьох демо ДЗ-22.
 *
 * Кожне демо зобовʼязане само привести стан до чистого, надрукувати підсумок
 * рядками ключ=число і само перевірити інваріант — код виходу визначає саме
 * перевірка, а не «скрипт доїхав до кінця».
 */

export interface Invariant {
  what: string;
  ok: boolean;
}

export function report(values: Record<string, number>, invariants: Invariant[]): never {
  for (const [key, value] of Object.entries(values)) console.log(`${key}=${value}`);

  const broken = invariants.filter((i) => !i.ok);
  if (broken.length === 0) {
    console.log(`\n✔ інваріант витримано: ${invariants.map((i) => i.what).join('; ')}`);
    process.exit(0);
  }

  console.error('\n✖ інваріант порушено:');
  for (const invariant of broken) console.error(`  — ${invariant.what}`);
  process.exit(1);
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  stepMs = 25,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(stepMs);
  }
  return condition();
}

/**
 * Чистий аркуш для демо outbox: прибираємо все, що створили попередні прогони.
 *
 * Сідові замовлення лишаємо: ефект і ключі привʼязані до замовлень демо, і
 * видалення саме їх каскадом зносить і те, й інше.
 */
export async function resetOutboxState(dataSource: DataSource, seedOrderIds: string[]): Promise<void> {
  await dataSource.transaction(async (manager) => {
    await manager.query('DELETE FROM outbox');
    await manager.query('DELETE FROM processed_messages');
    await manager.query('DELETE FROM idempotency_keys');
    await manager.query('DELETE FROM picking_tasks');
    await manager.query('DELETE FROM orders WHERE id <> ALL($1::bigint[])', [seedOrderIds]);
    await manager.query('DELETE FROM tasks');
  });
}

/** Імена таблиць у count-запитах — із білого списку, а не з рядка ззовні. */
type CountableTable = 'outbox' | 'picking_tasks' | 'processed_messages' | 'idempotency_keys';

export async function countRows(
  dataSource: DataSource,
  table: CountableTable,
): Promise<number> {
  const [{ count }] = (await dataSource.query(
    `SELECT count(*)::int AS count FROM ${table}`,
  )) as Array<{ count: number }>;
  return count;
}

/** Замовлення, створені демо: усе, що понад сідові рядки. */
export async function countDemoOrders(
  dataSource: DataSource,
  seedOrderIds: string[],
): Promise<number> {
  const [{ count }] = (await dataSource.query(
    'SELECT count(*)::int AS count FROM orders WHERE id <> ALL($1::bigint[])',
    [seedOrderIds],
  )) as Array<{ count: number }>;
  return count;
}

/** Скільки подій обробив консюмер (рядків inbox), а не скільки рядків ефекту. */
export const processedCount = countProcessed;

/**
 * Піднімає СПРАВЖНІЙ застосунок на вільному порту.
 *
 * Потрібен demo:outbox: ключ ідемпотентності перевіряється на API-краю, тож
 * два запити мають бути справжніми HTTP-запитами через ті самі middleware
 * (валідатор зі спеки, problem+json), що й у проді.
 */
export async function startApi(): Promise<{ baseUrl: string; stop(): Promise<void> }> {
  const { AppModule } = await import('../app.module');

  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    new ExpressAdapter(),
    { ...NEST_APP_OPTIONS, logger: ['error', 'warn'] },
  );
  configureApp(app);
  await app.listen(0);

  const { port } = app.getHttpServer().address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: () => app.close(),
  };
}
