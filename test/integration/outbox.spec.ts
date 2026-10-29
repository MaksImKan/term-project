import { DataSource } from 'typeorm';
import { Order, OrderItem, PickingTask, Product, Task, User } from '../../src/entities';
import { migrations } from '../../src/migrations';
import { applyWithInbox } from '../../src/outbox/inbox';
import { placeOrder } from '../../src/outbox/place-order';
import { relayOnce } from '../../src/outbox/relay';
import { countUnpublished } from '../../src/outbox/outbox';
import type { OrderPlacedEvent } from '../../src/messaging/contracts';
import { TestDatabase, startTestDatabase } from '../support/testkit';

/**
 * Outbox і три рівні ідемпотентності (ДЗ-22) проти справжнього Postgres.
 *
 * Брокера тут немає свідомо: усе, що це ДЗ обіцяє, — властивості ЗАПИСІВ у
 * базі, і перевіряти їх треба базою. Publisher підмінено лічильником, тож
 * тест детермінований і не потребує RabbitMQ — demo:crash-relay лишається
 * тим місцем, де ті самі інваріанти видно наскрізь, із реальним брокером.
 */
describe('Outbox + ідемпотентність (integration)', () => {
  jest.setTimeout(180_000);

  let db: TestDatabase;
  let ds: DataSource;
  let buyerId: string;
  let productId: string;

  beforeAll(async () => {
    db = await startTestDatabase();
    ds = new DataSource({
      type: 'postgres',
      url: db.uri,
      synchronize: false,
      logging: false,
      entities: [User, Product, Order, OrderItem, Task, PickingTask],
      migrations,
    });
    await ds.initialize();
  });

  afterAll(async () => {
    await ds?.destroy();
    await db?.stop();
  });

  beforeEach(async () => {
    await ds.query(
      'TRUNCATE outbox, processed_messages, idempotency_keys, picking_tasks, tasks, order_items, orders, products, users RESTART IDENTITY CASCADE',
    );
    const [buyer] = (await ds.query(
      `INSERT INTO users (email, full_name, city, balance_cents)
       VALUES ('buyer@example.com', 'Покупець', 'Київ', 10000000) RETURNING id`,
    )) as Array<{ id: string }>;
    buyerId = buyer.id;

    const [seller] = (await ds.query(
      `INSERT INTO users (email, full_name, city, balance_cents)
       VALUES ('seller@example.com', 'Продавець', 'Львів', 0) RETURNING id`,
    )) as Array<{ id: string }>;

    const [product] = (await ds.query(
      `INSERT INTO products (seller_id, name, description, price_cents, currency, stock)
       VALUES ($1, 'Шкіряні кросівки', 'опис', 249900, 'UAH', 10) RETURNING id`,
      [seller.id],
    )) as Array<{ id: string }>;
    productId = product.id;
  });

  /** Publisher-лічильник: нічого не шле, рахує виклики. */
  function stubPublisher() {
    const published: OrderPlacedEvent[] = [];
    return {
      published,
      publish: async (event: OrderPlacedEvent) => {
        published.push(event);
      },
    };
  }

  it('бізнес-рядок і подія лягають одним COMMIT', async () => {
    const result = await placeOrder(ds, 'key-1', { buyerId, productId, quantity: 2 });

    expect(result.replay).toBe(false);
    expect(await countOrders()).toBe(1);
    expect(await countOutbox()).toBe(1);

    const [row] = (await ds.query('SELECT aggregate_type, aggregate_id, type, payload FROM outbox')) as Array<{
      aggregate_type: string;
      aggregate_id: string;
      type: string;
      payload: OrderPlacedEvent;
    }>;
    expect(row.aggregate_type).toBe('order');
    expect(row.aggregate_id).toBe(result.orderId);
    expect(row.type).toBe('order.placed');
    // payload — спроектований контракт, а не сутність через spread: у ньому
    // немає ані stock, ані balance_cents, ані інших внутрішніх колонок.
    expect(Object.keys(row.payload.data).sort()).toEqual(
      ['buyerId', 'currency', 'orderId', 'productId', 'quantity', 'totalCents'].sort(),
    );
  });

  it('падіння бізнес-запису забирає з собою і подію', async () => {
    await expect(
      placeOrder(
        ds,
        'key-crash',
        { buyerId, productId, quantity: 1 },
        {
          afterEnqueue: () => {
            throw new Error('збій після вставки в outbox');
          },
        },
      ),
    ).rejects.toThrow('збій після вставки в outbox');

    // Якби записи були у двох транзакціях, рядок outbox тут лишився б.
    expect(await countOrders()).toBe(0);
    expect(await countOutbox()).toBe(0);
  });

  it('ключ ідемпотентності віддає те саме замовлення, не створюючи друге', async () => {
    const first = await placeOrder(ds, 'key-same', { buyerId, productId, quantity: 1 });
    const second = await placeOrder(ds, 'key-same', { buyerId, productId, quantity: 1 });

    expect(second.replay).toBe(true);
    expect(second.orderId).toBe(first.orderId);
    expect(await countOrders()).toBe(1);
    expect(await countOutbox()).toBe(1);

    // Ключ ідентифікує НАМІР: інший ключ із тим самим тілом — друге
    // замовлення, і це правильно.
    await placeOrder(ds, 'key-other', { buyerId, productId, quantity: 1 });
    expect(await countOrders()).toBe(2);
  });

  it('relay виносить лише невинесене і позначає його після публікації', async () => {
    await placeOrder(ds, 'key-relay', { buyerId, productId, quantity: 1 });
    const publisher = stubPublisher();

    const first = await relayOnce(ds, publisher);
    expect(first.published).toBe(1);
    expect(first.marked).toBe(1);
    expect(await countUnpublished(ds.manager)).toBe(0);

    // Другий прохід не має чого виносити — саме це робить relay безпечним
    // для запуску за розкладом.
    const second = await relayOnce(ds, publisher);
    expect(second.picked).toBe(0);
    expect(publisher.published).toHaveLength(1);
  });

  it('падіння між publish і UPDATE лишає подію невинесеною — і вона їде вдруге', async () => {
    await placeOrder(ds, 'key-crash-relay', { buyerId, productId, quantity: 1 });
    const publisher = stubPublisher();

    await expect(
      relayOnce(ds, publisher, {
        betweenPublishAndMark: () => {
          throw new Error('relay помер між publish і UPDATE');
        },
      }),
    ).rejects.toThrow('relay помер між publish і UPDATE');

    // Опублікувати вже встигли, позначити — ні. Саме тут народжується дубль.
    expect(publisher.published).toHaveLength(1);
    expect(await countUnpublished(ds.manager)).toBe(1);

    await relayOnce(ds, publisher);
    expect(publisher.published).toHaveLength(2);
    expect(await countUnpublished(ds.manager)).toBe(0);

    // Доставок дві — ефект один. Це і є «at-least-once + ідемпотентність».
    const [event] = publisher.published;
    expect(await applyWithInbox(ds, event)).toBe('applied');
    expect(await applyWithInbox(ds, event)).toBe('duplicate');

    const [{ count }] = (await ds.query('SELECT count(*)::int AS count FROM picking_tasks')) as Array<{
      count: number;
    }>;
    expect(count).toBe(1);
  });

  it('позначка inbox і ефект живуть в одній транзакції', async () => {
    const result = await placeOrder(ds, 'key-inbox', { buyerId, productId, quantity: 1 });
    const publisher = stubPublisher();
    await relayOnce(ds, publisher);
    const [event] = publisher.published;

    await applyWithInbox(ds, event);

    const [{ count: processed }] = (await ds.query(
      'SELECT count(*)::int AS count FROM processed_messages WHERE message_id = $1',
      [event.eventId],
    )) as Array<{ count: number }>;
    const [{ count: effect }] = (await ds.query(
      'SELECT count(*)::int AS count FROM picking_tasks WHERE order_id = $1',
      [result.orderId],
    )) as Array<{ count: number }>;

    // Обидва рядки є — і обидва зʼявились разом. Якби позначка жила в іншому
    // сховищі, падіння між двома записами лишило б подію «обробленою» без
    // ефекту, і повтор її вже не врятував би.
    expect(processed).toBe(1);
    expect(effect).toBe(1);
  });

  async function countOrders(): Promise<number> {
    const [{ count }] = (await ds.query('SELECT count(*)::int AS count FROM orders')) as Array<{
      count: number;
    }>;
    return count;
  }

  async function countOutbox(): Promise<number> {
    const [{ count }] = (await ds.query('SELECT count(*)::int AS count FROM outbox')) as Array<{
      count: number;
    }>;
    return count;
  }
});
