import type { ChannelModel, ConfirmChannel } from 'amqplib';
import { OrderPlacedEvent } from './contracts';
import { EXCHANGE, ROUTING_KEY } from './topology';

/**
 * Публікація подій домену.
 *
 * Два окремі механізми, і плутати їх не можна:
 *
 *  1. Confirm-канал (`createConfirmChannel` + `waitForConfirms`) відповідає на
 *     питання «брокер ВЗЯВ на себе відповідальність за це повідомлення?».
 *     Без нього `publish()` означає лише «віддав у сокет»: процес може впасти
 *     за мілісекунду до того, як дані полетять, і ніхто про це не дізнається.
 *
 *  2. `mandatory: true` + слухач `return` відповідає на інше питання — «а
 *     хтось це взагалі слухає?». Якщо жоден binding не збігся з routing key,
 *     брокер коректно викине повідомлення і ПРИ ЦЬОМУ надішле позитивний
 *     confirm: зі свого боку він усе зробив правильно. Неприйняте
 *     повідомлення повертається подією `return`, і тільки так публікація в
 *     нікуди стає видимою.
 *
 * Дешевша альтернатива mandatory для великих систем — alternate exchange:
 * одне налаштування на exchange замість прапорця на кожній публікації.
 */
export class OrderEventPublisher {
  private readonly returned: OrderPlacedEvent[] = [];

  private constructor(private readonly channel: ConfirmChannel) {}

  static async open(connection: ChannelModel): Promise<OrderEventPublisher> {
    const channel = await connection.createConfirmChannel();
    const publisher = new OrderEventPublisher(channel);

    channel.on('return', (message) => {
      // Сюди потрапляє те, що не збіглося з жодним binding.
      publisher.returned.push(JSON.parse(message.content.toString()) as OrderPlacedEvent);
    });

    return publisher;
  }

  /** Повідомлення, які брокер повернув як неприйняті (має бути порожньо). */
  get unroutable(): readonly OrderPlacedEvent[] {
    return this.returned;
  }

  /**
   * Опублікувати подію і дочекатися підтвердження брокера.
   *
   * `persistent: true` — щоб подія пережила рестарт брокера: durable-черга без
   * persistent-повідомлень рятує чергу, але не її вміст.
   */
  async publish(event: OrderPlacedEvent, routingKey = ROUTING_KEY): Promise<void> {
    this.channel.publish(EXCHANGE, routingKey, Buffer.from(JSON.stringify(event)), {
      persistent: true,
      mandatory: true,
      contentType: 'application/json',
      messageId: event.eventId,
      type: event.type,
      timestamp: Math.floor(Date.parse(event.occurredAt) / 1000),
    });

    await this.channel.waitForConfirms();
  }

  /**
   * Публікація сирого тіла — потрібна рівно одному сценарію: покласти в чергу
   * свідомо отруєне повідомлення для демонстрації DLQ.
   */
  async publishRaw(body: unknown, routingKey = ROUTING_KEY): Promise<void> {
    this.channel.publish(EXCHANGE, routingKey, Buffer.from(JSON.stringify(body)), {
      persistent: true,
      mandatory: true,
      contentType: 'application/json',
    });
    await this.channel.waitForConfirms();
  }

  async close(): Promise<void> {
    await this.channel.close();
  }
}
