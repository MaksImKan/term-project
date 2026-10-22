import 'reflect-metadata';
import { assertSeeded, openDataSource, resetDemoState } from './demo-support';
import { startConsumer } from './messaging/consumer';
import { OrderEventPublisher } from './messaging/publisher';
import { assertTopology, openConnection, purgeAll } from './messaging/topology';
import { applyWithInbox } from './outbox/inbox';
import { relayOnce } from './outbox/relay';
import {
  countDemoOrders,
  countRows,
  processedCount,
  report,
  resetOutboxState,
  startApi,
  waitFor,
} from './outbox/demo-support';
import { ORDERS, PRODUCTS, USERS } from './seed';

/**
 * demo:outbox — happy path усього ланцюжка.
 *
 *   bash scripts/with-secrets.sh dev node dist/demo-outbox.js
 *
 * ДВА HTTP-запити з ОДНАКОВИМ Idempotency-Key -> одне замовлення, один рядок
 * outbox, одна публікація, один ефект, один рядок inbox.
 *
 * Запити справжні: піднімається застосунок і стукаємо в POST /checkout через
 * ті самі middleware, що в проді. Ключ ідемпотентності тут — третій рівень
 * захисту, і він має спрацювати ДО того, як бізнес-операція взагалі почнеться.
 */
const PRODUCT_ID = PRODUCTS[0].id!;
const SEED_ORDER_IDS = ORDERS.map((order) => order.id!);

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

    // Консюмер із inbox: позначка і ефект — одним COMMIT.
    const consumer = await startConsumer(connection, {
      dataSource,
      prefetch: 10,
      apply: (event) => applyWithInbox(dataSource, event),
    });

    const api = await startApi();
    const key = `demo-outbox-${Date.now()}`;
    const body = JSON.stringify({ buyer_id: USERS[0].id!, product_id: PRODUCT_ID, quantity: 1 });

    let requests = 0;
    const responses: Array<{ order_id: string; replay: boolean }> = [];
    for (let i = 0; i < 2; i += 1) {
      const response = await fetch(`${api.baseUrl}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body,
      });
      requests += 1;
      if (response.status !== 201) {
        throw new Error(`POST /checkout -> ${response.status} ${await response.text()}`);
      }
      responses.push((await response.json()) as { order_id: string; replay: boolean });
      console.log(
        `[demo] запит ${i + 1}: order_id=${responses[i].order_id} replay=${responses[i].replay}`,
      );
    }
    await api.stop();

    const orders = await countDemoOrders(dataSource, SEED_ORDER_IDS);
    const outbox = await countRows(dataSource, 'outbox');

    // Relay виносить подію назовні — окремим кроком, уже після COMMIT.
    const publisher = await OrderEventPublisher.open(connection);
    const relay = await relayOnce(dataSource, publisher);

    await waitFor(() => consumer.stats.deliveries >= 1, 20_000);
    await waitFor(() => consumer.stats.applied >= 1, 20_000);

    const stats = { ...consumer.stats };
    const effect = await countRows(dataSource, 'picking_tasks');
    const processed = await processedCount(dataSource);

    await publisher.close();
    await consumer.stop();
    await setup.close();
    await connection.close();
    await dataSource.destroy();

    return report(
      {
        requests,
        orders,
        outbox,
        published: relay.published,
        deliveries: stats.deliveries,
        effect,
        processed,
      },
      [
        { what: 'два запити з тим самим ключем', ok: requests === 2 },
        { what: 'замовлення одне', ok: orders === 1 },
        { what: 'рядок outbox один', ok: outbox === 1 },
        { what: 'опубліковано один раз', ok: relay.published === 1 },
        { what: 'ефект застосовано один раз', ok: effect === 1 },
        { what: 'inbox має один рядок', ok: processed === 1 },
        { what: 'другий запит був повтором', ok: responses[1]?.replay === true },
        {
          what: 'обидва запити віддали те саме замовлення',
          ok: responses[0]?.order_id === responses[1]?.order_id,
        },
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
