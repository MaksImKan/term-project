import 'reflect-metadata';
import type { Message } from 'amqplib';
import { openDataSource } from './demo-support';
import { brokerPrefetch, report, resetDemo, sleep, waitFor } from './messaging/demo-support';
import { startConsumer } from './messaging/consumer';
import { countAppliedEffects } from './messaging/effect';
import { OrderEventPublisher } from './messaging/publisher';
import { DLQ, QUEUE, assertTopology, openConnection, queueDepth } from './messaging/topology';

/**
 * demo:dlq — отруєне повідомлення йде окремим контуром, і причина читабельна.
 *
 *   bash scripts/with-secrets.sh dev node dist/demo-dlq.js
 *
 * Отруєне — це не «зламалося при обробці», а «не стане валідним ніколи»:
 * подія без eventId не впізнається як дубль і не може дати коректний ефект,
 * скільки її не доставляй. Такому повідомленню місце в DLQ, а не в черзі, де
 * воно крутилося б вічно.
 *
 * Споживач відповідає `reject(requeue = false)`, брокер мертвить повідомлення
 * у x-dead-letter-exchange, і в заголовках зʼявляється x-death із причиною.
 * Причин у RabbitMQ рівно чотири: rejected, expired, maxlen, delivery_limit.
 *
 * Інваріант: робоча черга порожня, у DLQ рівно одне повідомлення, причина
 * прочитана, ефекту не сталося.
 */

/** Саме цього тіла споживач не прийме: немає eventId і type невідомий. */
const POISON = {
  type: 'order.placed.broken',
  occurredAt: new Date().toISOString(),
  data: { note: 'подія без eventId — упізнати дубль нічим' },
};

function deathReason(message: Message): string {
  const headers = message.properties.headers ?? {};

  // Сучасні брокери кладуть готовий рядок; на старших його треба дістати з
  // масиву x-death — беремо перший запис, він і є першою смертю.
  const first = headers['x-first-death-reason'];
  if (typeof first === 'string') return first;

  const deaths = headers['x-death'];
  if (Array.isArray(deaths) && deaths.length > 0) {
    const reason = (deaths[0] as { reason?: unknown }).reason;
    if (typeof reason === 'string') return reason;
  }
  return 'unknown';
}

async function main(): Promise<never> {
  const prefetch = brokerPrefetch();
  const dataSource = await openDataSource(5);
  const connection = await openConnection();

  try {
    const setup = await connection.createChannel();
    await assertTopology(setup);
    await resetDemo(setup, dataSource);

    const consumer = await startConsumer(connection, { dataSource, prefetch });

    const publisher = await OrderEventPublisher.open(connection);
    await publisher.publishRaw(POISON);

    // Чекаємо саме на відмову, а не на час.
    await waitFor(() => consumer.stats.rejected >= 1, 20_000);
    // Мертвіння асинхронне: брокер дописує повідомлення в DLQ вже після того,
    // як відповів на reject. Опитуємо глибину, а не спимо навмання.
    let dlq = 0;
    for (let attempt = 0; attempt < 100 && dlq < 1; attempt += 1) {
      dlq = await queueDepth(setup, DLQ);
      if (dlq < 1) await sleep(100);
    }

    // Дивимося на мертве повідомлення очима споживача DLQ: беремо його без
    // ack (requeue), щоб воно лишилось у черзі — глибина DLQ має бути видимою
    // і після демо.
    const dead = await setup.get(DLQ, { noAck: false });
    let reason = 'none';
    if (dead !== false) {
      reason = deathReason(dead);
      setup.nack(dead, false, true);
    }

    const work = await queueDepth(setup, QUEUE);
    const effect = await countAppliedEffects(dataSource);
    const rejected = consumer.stats.rejected;

    await publisher.close();
    await consumer.stop();
    await setup.close();
    await connection.close();
    await dataSource.destroy();

    return report(
      { rejected, work, dlq, 'dlq-reason': reason, effect, prefetch },
      [
        { what: 'повідомлення відкинуто споживачем', ok: rejected === 1 },
        { what: 'робоча черга порожня', ok: work === 0 },
        { what: 'у DLQ рівно одне повідомлення', ok: dlq === 1 },
        {
          what: 'причина смерті прочитана з x-death',
          ok: ['rejected', 'expired', 'maxlen', 'delivery_limit'].includes(reason),
        },
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
