import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import type { DataSource } from 'typeorm';
import { OrderPlacedEvent, parseOrderPlaced } from './contracts';
import { applyPickingTask } from './effect';
import { QUEUE, assertTopology } from './topology';

export interface ConsumerStats {
  /** Скільки доставок отримав цей споживач (повтор рахується окремо). */
  deliveries: number;
  /** Скільки разів ефект фактично застосовано. */
  applied: number;
  /** Скільки доставок відкинуто як дубль — ефект уже був. */
  skipped: number;
  /** Скільки повідомлень відправлено в DLQ як непридатні. */
  rejected: number;
}

export interface ConsumerOptions {
  dataSource: DataSource;
  /**
   * Скільки повідомлень брокер віддає наперед, не чекаючи ack.
   *
   * Дефолт брокера — 0, і нуль означає БЕЗ ЛІМІТУ: перший підписаний споживач
   * забирає всю чергу, другий простоює. Орієнтир для свого числа:
   * prefetch × час обробки < consumer_timeout (стокові 30 хв).
   */
  prefetch: number;
  /**
   * Хук між ефектом і ack — рівно та щілина, у якій падіння дає повторну
   * доставку. Використовується demo:duplicate, щоб показати її чесно.
   */
  afterEffect?: (event: OrderPlacedEvent, stats: ConsumerStats) => Promise<void> | void;
  onDelivery?: (stats: ConsumerStats) => void;
  /**
   * Чим саме застосовувати ефект. Типово — ідемпотентність лише за природним
   * ключем (ДЗ-19). ДЗ-22 підставляє сюди варіант з inbox-таблицею, де
   * позначка про обробку й ефект комітяться однією транзакцією.
   */
  apply?: (event: OrderPlacedEvent) => Promise<'applied' | 'duplicate'>;
}

export interface RunningConsumer {
  stats: ConsumerStats;
  stop(): Promise<void>;
}

/**
 * Споживач із РУЧНИМ підтвердженням.
 *
 * `noAck: false` і ack ПІСЛЯ ефекту — це не стиль, а різниця між «робота
 * втрачена» і «робота виконана». Під autoAck брокер вважає повідомлення
 * доставленим у момент відправки: падіння споживача забирає з собою все, що
 * було у вікні prefetch, і повертати вже нічого.
 *
 * Три рішення на доставку, і всі три тут явні:
 *   придатне   -> ефект, потім ack;
 *   непридатне -> reject(requeue=false): у DLQ, з причиною `rejected`. Повтор
 *                 такого повідомлення нічого не змінить — воно не стане
 *                 валідним від того, що його доставили вдруге;
 *   дубль      -> ack без ефекту: робота вже зроблена.
 */
export async function startConsumer(
  connection: ChannelModel,
  options: ConsumerOptions,
): Promise<RunningConsumer> {
  const channel: Channel = await connection.createChannel();
  await assertTopology(channel);
  await channel.prefetch(options.prefetch);

  const stats: ConsumerStats = { deliveries: 0, applied: 0, skipped: 0, rejected: 0 };

  const { consumerTag } = await channel.consume(
    QUEUE,
    async (message: ConsumeMessage | null) => {
      // null приходить, коли брокер скасував споживача (basic.cancel) —
      // наприклад після consumer_timeout. Наївний `if (!msg) return;` це
      // пропускає, і код далі шле ack у нікуди.
      if (message === null) return;

      stats.deliveries += 1;
      options.onDelivery?.(stats);

      let event: OrderPlacedEvent;
      try {
        event = parseOrderPlaced(JSON.parse(message.content.toString()));
      } catch (error) {
        stats.rejected += 1;
        console.error(
          `[consumer] отруєне повідомлення -> DLQ: ${error instanceof Error ? error.message : error}`,
        );
        // requeue = false: у DLQ, а не назад у чергу. Інакше воно крутилося б
        // вічно і гріло кластер.
        channel.reject(message, false);
        return;
      }

      try {
        const outcome = options.apply
          ? await options.apply(event)
          : await applyPickingTask(options.dataSource, event);
        if (outcome === 'applied') stats.applied += 1;
        else stats.skipped += 1;

        await options.afterEffect?.(event, stats);

        // ack ТІЛЬКИ тут: ефект уже в базі.
        channel.ack(message);
      } catch (error) {
        // Помилка інфраструктури (база недоступна) — це не отруєне
        // повідомлення: повертаємо в чергу, delivery-limit черги не дасть
        // циклу стати вічним.
        console.error(
          `[consumer] збій обробки, повертаємо в чергу: ${error instanceof Error ? error.message : error}`,
        );
        channel.nack(message, false, true);
      }
    },
    { noAck: false },
  );

  return {
    stats,
    async stop() {
      await channel.cancel(consumerTag);
      await channel.close();
    },
  };
}
