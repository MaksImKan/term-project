import 'reflect-metadata';
import { checkout } from './checkout';
import { assertSeeded, openDataSource, resetDemoState } from './demo-support';
import { brokerPrefetch, report, resetDemo, waitFor } from './messaging/demo-support';
import { startConsumer } from './messaging/consumer';
import { OrderEventPublisher } from './messaging/publisher';
import { DLQ, QUEUE, assertTopology, openConnection, queueDepth } from './messaging/topology';
import { PRODUCTS, USERS } from './seed';

/**
 * demo:publish — happy path: пʼять подій доходять і дають рівно пʼять ефектів.
 *
 *   bash scripts/with-secrets.sh dev node dist/demo-publish.js
 *
 * Події не вигадані збоку: кожна виходить із реального checkout — тієї самої
 * критичної бізнес-операції з ДЗ-14. Публікація йде через confirm-канал із
 * mandatory, тож «опублікував» тут означає «брокер узяв відповідальність і
 * повідомлення збіглося з binding», а не «віддав у сокет».
 *
 * Інваріант: published = effect = 5, у DLQ порожньо.
 */
const ORDERS_TO_PLACE = 5;
const PRODUCT_ID = PRODUCTS[0].id!;

async function main(): Promise<never> {
  const prefetch = brokerPrefetch();
  const dataSource = await openDataSource(ORDERS_TO_PLACE + 5);
  const connection = await openConnection();

  try {
    await assertSeeded(dataSource);

    const setup = await connection.createChannel();
    await assertTopology(setup);

    // 1. Чистий аркуш: порожні черги, прибрані ефекти, відомий stock.
    await resetDemo(setup, dataSource);
    await resetDemoState(dataSource, { stock: ORDERS_TO_PLACE, productId: PRODUCT_ID });

    // 2. Споживач стартує ПЕРШИМ: інакше перші повідомлення полежать у черзі,
    //    і демо чекатиме на них довше без жодної користі.
    const consumer = await startConsumer(connection, { dataSource, prefetch });

    // 3. Пʼять замовлень — пʼять подій.
    const publisher = await OrderEventPublisher.open(connection);
    const buyers = USERS.map((user) => user.id!);

    let published = 0;
    for (let i = 0; i < ORDERS_TO_PLACE; i += 1) {
      await checkout(
        dataSource,
        { buyerId: buyers[i % buyers.length], productId: PRODUCT_ID, quantity: 1 },
        publisher,
      );
      published += 1;
    }

    // 4. Чекаємо, поки ефекти застосуються, а не спимо «на око».
    await waitFor(() => consumer.stats.applied >= ORDERS_TO_PLACE, 20_000);

    const work = await queueDepth(setup, QUEUE);
    const dlq = await queueDepth(setup, DLQ);
    const stats = { ...consumer.stats };
    const unroutable = publisher.unroutable.length;

    await publisher.close();
    await consumer.stop();
    await setup.close();
    await connection.close();
    await dataSource.destroy();

    return report(
      {
        published,
        delivered: stats.deliveries,
        effect: stats.applied,
        acked: stats.applied + stats.skipped,
        work,
        dlq,
        unroutable,
        prefetch,
      },
      [
        { what: `опубліковано ${ORDERS_TO_PLACE}`, ok: published === ORDERS_TO_PLACE },
        { what: `ефект застосовано ${ORDERS_TO_PLACE} разів`, ok: stats.applied === ORDERS_TO_PLACE },
        { what: 'у DLQ порожньо', ok: dlq === 0 },
        { what: 'робоча черга розібрана', ok: work === 0 },
        { what: 'жодна подія не пішла в нікуди (mandatory)', ok: unroutable === 0 },
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
