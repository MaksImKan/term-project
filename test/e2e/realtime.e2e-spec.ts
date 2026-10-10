import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import { ExpressAdapter, NestExpressApplication } from '@nestjs/platform-express';
import { io, Socket } from 'socket.io-client';
import { NEST_APP_OPTIONS, configureApp } from '../../src/bootstrap';
import { Queryable } from '../../src/repositories/types';
import { aProduct, insertProduct, insertUser } from '../support/builders';
import { TestDatabase, appEnvFor, startTestDatabase, truncateAll } from '../support/testkit';

/**
 * Realtime (ДЗ-18) на повному застосунку: SSE-потік і WebSocket-кімнати.
 *
 * Те саме, що доводить scripts/realtime-demo.mjs, але в CI і без зовнішнього
 * процесу. Сенс дублювання: демо показує людині, тест ловить регрес — якщо
 * хтось заміняє `server.to(room).emit` на `server.emit`, тут стає червоно.
 *
 * Кожен кейс працює з ВЛАСНИМ замовленням: нумерація подій наскрізна в межах
 * замовлення, тож спільне замовлення зробило б очікувані id залежними від
 * порядку тестів.
 */
describe('Realtime: SSE + WebSocket (e2e)', () => {
  jest.setTimeout(120_000);

  let db: TestDatabase;
  let app: NestExpressApplication;
  let baseUrl: string;
  let productId: string;

  beforeAll(async () => {
    db = await startTestDatabase();

    const env = appEnvFor(db.uri);
    process.env.DB_URL = env.DB_URL;
    process.env.DB_PASSWORD_FILE = env.DB_PASSWORD_FILE;
    process.env.NODE_ENV = 'test';
    process.env.VALIDATE_RESPONSES = 'true';

    const { AppModule } = await import('../../src/app.module');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>(
      new ExpressAdapter(),
      NEST_APP_OPTIONS,
    );
    configureApp(app);

    // Справжній порт: і socket.io-client, і SSE ходять звичайним HTTP, тож
    // in-memory supertest тут не підійшов би.
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    await truncateAll(db.pool);
    const sellerId = await insertUser(db.pool as unknown as Queryable);
    productId = await insertProduct(
      db.pool as unknown as Queryable,
      sellerId,
      aProduct({ name: 'Шкіряні кросівки', priceCents: 249_900, stock: 50 }),
    );
  });

  afterAll(async () => {
    await app?.close();
    await db?.stop();
  });

  /** Нове замовлення на кожен кейс — чистий лічильник подій. */
  async function createOrder(userId = 'u_1'): Promise<string> {
    const response = await fetch(`${baseUrl}/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `rt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        'X-User-Id': userId,
      },
      body: JSON.stringify({ items: [{ product_id: productId, quantity: 1 }] }),
    });
    expect(response.status).toBe(201);
    const order = (await response.json()) as { id: string; buyer_id: string };
    expect(order.buyer_id).toBe(userId);
    return order.id;
  }

  async function patchStatus(orderId: string, status: string): Promise<void> {
    const response = await fetch(`${baseUrl}/orders/${orderId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    expect(response.status).toBe(200);
  }

  /**
   * Читає потік, поки в ньому не набереться `wanted` рядків `id:`, і повертає
   * усе прочитане. Читаємо до умови, а не фіксований час: інакше тест або
   * довгий, або мерехтливий.
   */
  async function readStream(
    path: string,
    headers: Record<string, string>,
    wanted: number,
    after?: () => Promise<void>,
  ): Promise<{ contentType: string | null; body: string }> {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}${path}`, { headers, signal: controller.signal });
    expect(response.status).toBe(200);

    const contentType = response.headers.get('content-type');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let body = '';

    // Дію, що породжує події, запускаємо вже ПІСЛЯ того, як потік відкрито.
    if (after) await after();

    const deadline = Date.now() + 20_000;
    while (countIds(body) < wanted && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      body += decoder.decode(value, { stream: true });
    }

    controller.abort();
    return { contentType, body };
  }

  function countIds(body: string): number {
    return body.split('\n').filter((line) => line.startsWith('id:')).length;
  }

  function connect(userId: string | null): Promise<Socket> {
    const socket = io(baseUrl, {
      auth: userId ? { userId } : {},
      transports: ['websocket'],
      reconnection: false,
    });
    return new Promise((resolve, reject) => {
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', reject);
    });
  }

  function join(socket: Socket, orderId: string): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => socket.emit('join', { orderId }, resolve));
  }

  it('SSE: віддає text/event-stream і блок id/event/data після зміни статусу', async () => {
    const orderId = await createOrder();

    const { contentType, body } = await readStream(`/orders/${orderId}/events`, {}, 1, () =>
      patchStatus(orderId, 'paid'),
    );

    expect(contentType).toBe('text/event-stream');
    // Перший рядок задає темп реконекту — без нього клієнт чекає свій дефолт.
    expect(body.startsWith('retry: ')).toBe(true);
    expect(body).toMatch(/^id: 1$/m);
    expect(body).toMatch(/^event: order\.status$/m);

    const data = JSON.parse(/^data: (.+)$/m.exec(body)![1]) as Record<string, unknown>;
    expect(data).toMatchObject({
      id: 1,
      order_id: orderId,
      status: 'paid',
      previous_status: 'created',
    });
  });

  it('SSE: Last-Event-ID доганяє пропущене і не дублює вже бачене', async () => {
    const orderId = await createOrder();

    // Чотири, а не три: при рівно трьох подіях подій з id > 3 ще не існує.
    for (const status of ['paid', 'cancelled', 'paid', 'cancelled']) {
      await patchStatus(orderId, status);
    }

    const { body } = await readStream(`/orders/${orderId}/events`, { 'Last-Event-ID': '3' }, 1);

    const ids = [...body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids.length).toBeGreaterThan(0);
    expect(Math.min(...ids)).toBeGreaterThan(3);
    expect(ids).toEqual([4]);
  });

  it('WS: подія летить лише в кімнату свого замовлення', async () => {
    const orderA = await createOrder();
    const orderB = await createOrder();

    const clientA = await connect('u_1');
    const clientB = await connect('u_1');

    try {
      expect(await join(clientA, orderA)).toMatchObject({ ok: true, room: `orders:${orderA}` });
      expect(await join(clientB, orderB)).toMatchObject({ ok: true, room: `orders:${orderB}` });

      const heardA: unknown[] = [];
      const heardB: unknown[] = [];
      clientA.on('order.status', (e) => heardA.push(e));
      clientB.on('order.status', (e) => heardB.push(e));

      await patchStatus(orderA, 'paid');
      await waitFor(() => heardA.length > 0, 10_000);
      // Дати завідомо достатньо часу, щоб «зайва» подія встигла б долетіти:
      // інакше зелений тест означав би лише «B повільніший».
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(heardA).toHaveLength(1);
      expect(heardB).toHaveLength(0);
      expect(heardA[0]).toMatchObject({ order_id: orderA, status: 'paid' });
    } finally {
      clientA.close();
      clientB.close();
    }
  });

  it('WS: анонімному й чужому join відмовляє', async () => {
    const orderId = await createOrder('u_owner');

    const anonymous = await connect(null);
    const foreigner = await connect('u_someone_else');
    const owner = await connect('u_owner');

    try {
      expect(await join(anonymous, orderId)).toEqual({ ok: false, error: 'anonymous' });
      expect(await join(foreigner, orderId)).toEqual({ ok: false, error: 'forbidden' });
      expect(await join(owner, 'o_does_not_exist')).toEqual({ ok: false, error: 'not_found' });
      // А власник проходить — інакше тест був би зеленим і від «нікого не пускаємо».
      expect(await join(owner, orderId)).toMatchObject({ ok: true });
    } finally {
      anonymous.close();
      foreigner.close();
      owner.close();
    }
  });

  async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
});
