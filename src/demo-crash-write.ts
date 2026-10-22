import 'reflect-metadata';
import { assertSeeded, openDataSource, resetDemoState } from './demo-support';
import { startConsumer } from './messaging/consumer';
import { OrderEventPublisher } from './messaging/publisher';
import { assertTopology, openConnection, purgeAll } from './messaging/topology';
import { applyWithInbox } from './outbox/inbox';
import { placeOrder } from './outbox/place-order';
import { relayOnce } from './outbox/relay';
import {
  countDemoOrders,
  countRows,
  report,
  resetOutboxState,
  sleep,
} from './outbox/demo-support';
import { ORDERS, PRODUCTS, USERS } from './seed';

/**
 * demo:crash-write — падіння БІЗНЕС-запису.
 *
 *   bash scripts/with-secrets.sh dev node dist/demo-crash-write.js
 *
 * Транзакція валиться вже ПІСЛЯ того, як рядок outbox вставлено. Якщо записи
 * справді в одному COMMIT, зникнути мають ОБИДВА: і замовлення, і подія.
 * Саме тому хук кидає після `enqueueEvent`, а не до нього — інакше демо
 * доводило б лише те, що ROLLBACK прибирає замовлення, а про outbox не казало
 * б нічого.
 *
 * Релей після цього запускається навмисно: він має не знайти чого виносити.
 * Подія, яка не пережила бізнес-транзакцію, не може зʼявитися назовні —
 * у цьому вся різниця між outbox і publish одразу після COMMIT.
 */
const PRODUCT_ID = PRODUCTS[0].id!;
const SEED_ORDER_IDS = ORDERS.map((order) => order.id!);

class IntentionalWriteFailure extends Error {
  constructor() {
    super('змодельований збій бізнес-запису ПІСЛЯ вставки рядка в outbox');
    this.name = 'IntentionalWriteFailure';
  }
}

async function main(): Promise<never> {
  const dataSource = await openDataSource(10);
  const connection = await openConnection();

  try {
    await assertSeeded(dataSource);

    const setup = await connection.createChannel();
    await assertTopology(setup);
    await purgeAll(setup);
    await resetOutboxState(dataSource, SEED_ORDER_IDS);
    await resetDemoState(dataSource, { stock: 5, productId: PRODUCT_ID });

    const consumer = await startConsumer(connection, {
      dataSource,
      prefetch: 10,
      apply: (event) => applyWithInbox(dataSource, event),
    });

    let writeFailed = 0;
    try {
      await placeOrder(
        dataSource,
        `demo-crash-write-${Date.now()}`,
        { buyerId: USERS[0].id!, productId: PRODUCT_ID, quantity: 1 },
        {
          afterEnqueue: () => {
            // Рядок outbox уже в транзакції. Падаємо саме тут.
            throw new IntentionalWriteFailure();
          },
        },
      );
    } catch (error) {
      if (!(error instanceof IntentionalWriteFailure)) throw error;
      writeFailed = 1;
      console.log(`[demo] ${error.message}`);
    }

    const orders = await countDemoOrders(dataSource, SEED_ORDER_IDS);
    const outbox = await countRows(dataSource, 'outbox');

    // Relay запускаємо попри все: він має не знайти чого виносити.
    const publisher = await OrderEventPublisher.open(connection);
    const relay = await relayOnce(dataSource, publisher);

    // Даємо консюмеру час отримати те, чого не має бути.
    await sleep(700);

    const effect = await countRows(dataSource, 'picking_tasks');
    const deliveries = consumer.stats.deliveries;

    await publisher.close();
    await consumer.stop();
    await setup.close();
    await connection.close();
    await dataSource.destroy();

    return report(
      {
        'write-failed': writeFailed,
        orders,
        outbox,
        published: relay.published,
        deliveries,
        effect,
      },
      [
        { what: 'бізнес-запис справді впав', ok: writeFailed === 1 },
        { what: 'замовлення не створено', ok: orders === 0 },
        { what: 'рядок outbox відкотився разом із ним', ok: outbox === 0 },
        { what: 'relay не мав чого виносити', ok: relay.published === 0 },
        { what: 'назовні нічого не доставлено', ok: deliveries === 0 },
        { what: 'ефекту не сталося', ok: effect === 0 },
      ],
    );
  } catch (error) {
    await dataSource.destroy().catch(() => undefined);
    await connection.close().catch(() => undefined);
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
