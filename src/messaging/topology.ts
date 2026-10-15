import type { Channel, ChannelModel } from 'amqplib';
import { connect } from 'amqplib';
import { ORDER_PLACED } from './contracts';

/**
 * Топологія домену: exchange + черга + binding + окремий контур DLQ.
 *
 * Оголошує її СПОЖИВАЧ (точніше — цей бутстрап-крок, який споживач і демо
 * викликають перед роботою), а не продюсер. Продюсер не має знати, хто його
 * слухає: він публікує факт у exchange із routing key, і все.
 *
 * Зворотний бік цього поділу: routing key без відповідного binding — порожній
 * звук. Брокер коректно викине повідомлення і при цьому поверне продюсеру
 * ПОЗИТИВНИЙ confirm, бо зі свого боку він усе зробив правильно. Саме тому
 * публікація нижче йде з `mandatory: true` і слухачем basic.return.
 */
export const EXCHANGE = 'shop.events';
export const DLX = 'shop.events.dlx';

export const QUEUE = 'shop.order.placed';
export const DLQ = 'shop.order.placed.dlq';

export const ROUTING_KEY = ORDER_PLACED;
export const DEAD_ROUTING_KEY = `${ORDER_PLACED}.dead`;

/**
 * Скільки разів повідомлення може бути доставлене, перш ніж поїхати в DLQ.
 *
 * Працює лише в quorum-чергах — і це головна причина обрати саме їх: без
 * delivery-limit повідомлення, яке споживач безкінечно повертає в чергу,
 * крутиться там вічно і гріє кластер.
 */
export const DELIVERY_LIMIT = 5;

export async function openConnection(url = process.env.BROKER_URL): Promise<ChannelModel> {
  if (!url) {
    throw new Error(
      'Немає BROKER_URL. Значення приходить зі сховища: bash scripts/with-secrets.sh dev …\n' +
        'Без сховища: export BROKER_URL=amqp://app:app@127.0.0.1:5672 SKIP_VAULT=1',
    );
  }
  return connect(url);
}

/**
 * Ідемпотентне оголошення топології. Можна викликати скільки завгодно разів.
 */
export async function assertTopology(channel: Channel): Promise<void> {
  await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
  await channel.assertExchange(DLX, 'topic', { durable: true });

  // DLQ оголошуємо ПЕРШОЮ: якщо робоча черга почне мертвити повідомлення
  // раніше, ніж існує черга під DLX, вони зникнуть безслідно.
  await channel.assertQueue(DLQ, {
    durable: true,
    arguments: { 'x-queue-type': 'quorum' },
  });
  await channel.bindQueue(DLQ, DLX, DEAD_ROUTING_KEY);

  try {
    await channel.assertQueue(QUEUE, {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        // Куди їде повідомлення, від якого споживач відмовився (reject/nack
        // із requeue=false), яке протухло або перевищило delivery-limit.
        'x-dead-letter-exchange': DLX,
        'x-dead-letter-routing-key': DEAD_ROUTING_KEY,
        'x-delivery-limit': DELIVERY_LIMIT,
      },
    });
  } catch (error) {
    // Аргументи вже існуючої черги змінити не можна — брокер відповідає
    // 406 PRECONDITION_FAILED і вбиває канал. Це не баг клієнта, тож
    // пояснюємо, що робити, замість стектрейсу про closed channel.
    const message = error instanceof Error ? error.message : String(error);
    if (/PRECONDITION[-_ ]FAILED/i.test(message)) {
      throw new Error(
        `Черга ${QUEUE} вже існує з іншими аргументами: ${message}\n` +
          `Аргументи черги незмінні. Знести й оголосити заново:\n` +
          `  rabbitmqctl delete_queue ${QUEUE}\n` +
          `(альтернатива для проду — вішати DLX політикою: політику можна перезаписати)`,
      );
    }
    throw error;
  }

  await channel.bindQueue(QUEUE, EXCHANGE, ROUTING_KEY);
}

/** Глибина черги — скільки повідомлень у ній лежить просто зараз. */
export async function queueDepth(channel: Channel, queue: string): Promise<number> {
  const { messageCount } = await channel.checkQueue(queue);
  return messageCount;
}

/** Привести черги до порожнього стану: кожне демо стартує з чистого аркуша. */
export async function purgeAll(channel: Channel): Promise<void> {
  await channel.purgeQueue(QUEUE);
  await channel.purgeQueue(DLQ);
}
