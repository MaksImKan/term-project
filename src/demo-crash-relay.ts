import 'reflect-metadata';
import { assertSeeded, openDataSource, resetDemoState } from './demo-support';
import { startConsumer } from './messaging/consumer';
import { OrderEventPublisher } from './messaging/publisher';
import { assertTopology, openConnection, purgeAll } from './messaging/topology';
import { applyWithInbox } from './outbox/inbox';
import { placeOrder } from './outbox/place-order';
import { relayOnce } from './outbox/relay';
import {
  countRows,
  processedCount,
  report,
  resetOutboxState,
  waitFor,
} from './outbox/demo-support';
import { ORDERS, PRODUCTS, USERS } from './seed';

/**
 * demo:crash-relay — падіння СЛУЖБОВОГО запису. Серце ДЗ.
 *
 *   bash scripts/with-secrets.sh dev node dist/demo-crash-relay.js
 *
 * Relay помирає рівно МІЖ `publish` і `UPDATE published_at`. Подія вже в
 * черзі, але в базі лишилась непозначеною — отже наступний прохід relay
 * винесе її ВДРУГЕ. Це не баг і не недогляд: це і є at-least-once.
 *
 * Форма падіння тут — змодельований обрив: виняток із хука
 * `betweenPublishAndMark`, через який транзакція relay відкочується рівно в
 * тій точці, де справжній процес отримав би SIGKILL. Наслідок для бази той
 * самий — `published_at` лишається NULL, — а демо стає детермінованим і не
 * залежить від того, чи встиг дочірній процес дописати stdout. Критерій
 * перевіряє наслідок, а не спосіб; обидві форми легальні.
 *
 * Що доводить демо: exactly-once ти отримуєш НЕ від брокера. Доставок дві,
 * а ефект один — і один він рівно тому, що консюмер ідемпотентний.
 */
const PRODUCT_ID = PRODUCTS[0].id!;
const SEED_ORDER_IDS = ORDERS.map((order) => order.id!);

class RelayCrash extends Error {
  constructor() {
    super('змодельоване падіння relay між publish і UPDATE published_at');
    this.name = 'RelayCrash';
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

    // Одне замовлення — один рядок outbox, одним COMMIT.
    await placeOrder(dataSource, `demo-crash-relay-${Date.now()}`, {
      buyerId: USERS[0].id!,
      productId: PRODUCT_ID,
      quantity: 1,
    });

    const publisher = await OrderEventPublisher.open(connection);

    // Прохід 1: publish відбувся, UPDATE — ні.
    let publishedAttempts = 0;
    try {
      const crashed = await relayOnce(dataSource, publisher, {
        betweenPublishAndMark: () => {
          throw new RelayCrash();
        },
      });
      publishedAttempts += crashed.published;
      throw new Error('relay не впав, хоча мав');
    } catch (error) {
      if (!(error instanceof RelayCrash)) throw error;
      // publish устиг відбутися до кидка — рахуємо його руками, бо статистика
      // того проходу згоріла разом із транзакцією.
      publishedAttempts += 1;
      console.log(`[demo] ${error.message}`);
    }

    await waitFor(() => consumer.stats.deliveries >= 1, 20_000);

    const unpublishedAfterCrash = await countUnpublished(dataSource);
    console.log(`[demo] невинесених подій після падіння: ${unpublishedAfterCrash}`);

    // Прохід 2: той самий рядок усе ще published_at IS NULL — виносимо вдруге.
    const second = await relayOnce(dataSource, publisher);
    publishedAttempts += second.published;

    await waitFor(() => consumer.stats.deliveries >= 2, 20_000);
    await waitFor(() => consumer.stats.skipped >= 1, 20_000);

    const deliveries = consumer.stats.deliveries;
    const applied = await countPublishedRows(dataSource);
    const effect = await countRows(dataSource, 'picking_tasks');
    const processed = await processedCount(dataSource);

    await publisher.close();
    await consumer.stop();
    await setup.close();
    await connection.close();
    await dataSource.destroy();

    return report(
      { published: publishedAttempts, deliveries, applied, effect, processed },
      [
        { what: 'подію опубліковано двічі', ok: publishedAttempts >= 2 },
        { what: 'консюмер отримав щонайменше дві доставки', ok: deliveries >= 2 },
        { what: 'рядок outbox зрештою позначено винесеним рівно один', ok: applied === 1 },
        { what: 'ефект застосовано рівно один раз', ok: effect === 1 },
        { what: 'inbox має рівно один рядок', ok: processed === 1 },
        {
          what: 'після падіння подія лишалась невинесеною',
          ok: unpublishedAfterCrash === 1,
        },
      ],
    );
  } catch (error) {
    await dataSource.destroy().catch(() => undefined);
    await connection.close().catch(() => undefined);
    throw error;
  }
}

async function countUnpublished(dataSource: import('typeorm').DataSource): Promise<number> {
  const [{ count }] = (await dataSource.query(
    'SELECT count(*)::int AS count FROM outbox WHERE published_at IS NULL',
  )) as Array<{ count: number }>;
  return count;
}

async function countPublishedRows(dataSource: import('typeorm').DataSource): Promise<number> {
  const [{ count }] = (await dataSource.query(
    'SELECT count(*)::int AS count FROM outbox WHERE published_at IS NOT NULL',
  )) as Array<{ count: number }>;
  return count;
}

main().catch((error: unknown) => {
  console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
