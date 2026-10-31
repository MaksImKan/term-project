import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ExpressAdapter, NestExpressApplication } from '@nestjs/platform-express';
import { NestFactory } from '@nestjs/core';
import type { DataSource } from 'typeorm';
import { NEST_APP_OPTIONS, configureApp } from '../bootstrap';
import { hashPassword, UserRole } from './tokens';

/**
 * Спільна частина трьох демо ДЗ-24.
 *
 * Контракт виводу: один рядок = `ключ=число`, без пробілів усередині рядка.
 * Числа тут — HTTP-статуси, тобто детерміновані: вивід не має плавати від
 * прогону до прогону.
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

export interface RunningApi {
  baseUrl: string;
  dataSource: DataSource;
  stop(): Promise<void>;
}

/**
 * Піднімає СПРАВЖНІЙ застосунок на вільному порту (`listen(0)`).
 *
 * Порт 0, а не фіксований: інакше другий прогін ловив би EADDRINUSE від
 * сервера, залишеного попереднім. Процес застосунку живе рівно стільки,
 * скільки демо, і закривається в `stop()`.
 */
export async function startApi(): Promise<RunningApi> {
  const { AppModule } = await import('../app.module');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, new ExpressAdapter(), {
    ...NEST_APP_OPTIONS,
    logger: ['error', 'warn'],
  });
  configureApp(app);
  await app.listen(0);

  const { port } = app.getHttpServer().address() as AddressInfo;
  const { DatabaseService } = await import('../db/database.service');
  const dataSource = await app.get(DatabaseService).orm();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    dataSource,
    stop: () => app.close(),
  };
}

export interface Fixture {
  id: string;
  email: string;
  password: string;
  role: UserRole;
}

/**
 * Користувач під конкретний прогін.
 *
 * Своя адреса на кожен запуск — це і є «сам приводить стан до чистого»:
 * демо не чіпає сідових користувачів і не залежить від того, що лишилось
 * після попереднього прогону.
 */
export async function createUser(
  dataSource: DataSource,
  role: UserRole,
  password = 'demo-password',
): Promise<Fixture> {
  const email = `demo-${role}-${randomUUID()}@example.com`;
  const rows = (await dataSource.query(
    `INSERT INTO users (email, full_name, city, balance_cents, role, password_hash)
     VALUES ($1, $2, 'Київ', 100000000, $3, $4)
     RETURNING id`,
    [email, `Демо ${role}`, role, hashPassword(password)],
  )) as Array<{ id: string }>;

  return { id: rows[0].id, email, password, role };
}

/** Замовлення конкретного покупця — щоб було що перевіряти на власність. */
export async function createOrderFor(dataSource: DataSource, buyerId: string): Promise<string> {
  const rows = (await dataSource.query(
    `INSERT INTO orders (buyer_id, status, total_cents, currency)
     VALUES ($1, 'pending', 1000, 'UAH')
     RETURNING id`,
    [buyerId],
  )) as Array<{ id: string }>;
  return rows[0].id;
}

/**
 * Прибрати за собою: демо не лишає в базі ані користувачів, ані їхніх рядків.
 *
 * Порядок має значення: `refresh_tokens` ідуть каскадом за користувачем, а от
 * `orders.buyer_id` і `products.seller_id` каскаду не мають — вони зі схеми
 * ДЗ-12, де видалення користувача не мало б тихо зносити історію замовлень.
 * Тому спершу знімаємо те, що посилається, і лише потім користувача.
 */
export async function cleanupUsers(dataSource: DataSource, ids: string[]): Promise<void> {
  if (ids.length === 0) return;

  await dataSource.transaction(async (manager) => {
    // order_items, tasks, picking_tasks та idempotency_keys ідуть каскадом
    // за самими замовленнями.
    await manager.query('DELETE FROM orders WHERE buyer_id = ANY($1::bigint[])', [ids]);
    await manager.query('DELETE FROM products WHERE seller_id = ANY($1::bigint[])', [ids]);
    await manager.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [ids]);
  });
}

export interface HttpResult {
  status: number;
  body: unknown;
}

export async function call(
  baseUrl: string,
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<HttpResult> {
  const { token, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (rest.body) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(`${baseUrl}${path}`, { ...rest, headers });
  const text = await response.text();

  let body: unknown = text;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    /* лишаємо текстом */
  }
  return { status: response.status, body };
}

export async function login(
  baseUrl: string,
  user: Fixture,
): Promise<{ status: number; access: string; refresh: string }> {
  const result = await call(baseUrl, '/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  const body = result.body as { access_token?: string; refresh_token?: string } | null;
  return {
    status: result.status,
    access: body?.access_token ?? '',
    refresh: body?.refresh_token ?? '',
  };
}

/**
 * Підробити токен: лишити підпис, підмінити payload.
 *
 * Найдешевший спосіб довести, що підпис СПРАВДІ перевіряється: рішення на
 * `jwt.decode()` віддасть на такому токені 201, а не 401.
 */
export function tamperRole(token: string, role = 'admin'): string {
  const parts = token.split('.');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as Record<
    string,
    unknown
  >;
  payload.role = role;
  parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return parts.join('.');
}
