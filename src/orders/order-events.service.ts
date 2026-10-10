import { Injectable, Logger } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';

/**
 * Подія зміни статусу замовлення.
 *
 * `id` наскрізний У МЕЖАХ ЗАМОВЛЕННЯ і зростає з 1. Саме його SSE віддає
 * рядком `id:`, і саме його клієнт повертає заголовком `Last-Event-ID`, коли
 * реконектиться. Глобальний лічильник тут не підійшов би: клієнт читає потік
 * одного замовлення, і «пропущене» для нього означає «з більшим номером у ЦЬОМУ
 * потоці», а не в усьому застосунку.
 */
export interface OrderStatusEvent {
  id: number;
  order_id: string;
  status: string;
  previous_status: string;
  at: string;
}

/** Скільки останніх подій на замовлення тримаємо для реконекту. */
const BUFFER_SIZE = 100;

/**
 * Шина подій: ОДНА на два транспорти.
 *
 * Навмисно не всередині gateway: SSE-контролер ходить у той самий буфер і той
 * самий Subject, тож WebSocket і SSE за визначенням віддають один і той самий
 * потік. Якби буфер жив у gateway, SSE довелося б дублювати стан — і два
 * транспорти рано чи пізно розійшлися б.
 *
 * Межі чесно: буфер у памʼяті процесу. Переживе реконект клієнта, але не
 * рестарт застосунку і не другий інстанс — про це окремо в README.
 */
@Injectable()
export class OrderEventsService {
  private readonly logger = new Logger(OrderEventsService.name);
  private readonly subject = new Subject<OrderStatusEvent>();

  /** orderId -> останні події цього замовлення, у порядку зростання id. */
  private readonly buffers = new Map<string, OrderStatusEvent[]>();
  /** orderId -> номер останньої виданої події. */
  private readonly sequences = new Map<string, number>();

  /** Потік усіх подій. Фільтрувати за orderId — робота підписника. */
  get stream(): Observable<OrderStatusEvent> {
    return this.subject.asObservable();
  }

  /**
   * Опублікувати подію. Викликається з бізнес-логіки (OrdersService), а не з
   * контролера й не з gateway: транспорти лише підписані на результат.
   */
  publish(input: Omit<OrderStatusEvent, 'id' | 'at'>): OrderStatusEvent {
    const id = (this.sequences.get(input.order_id) ?? 0) + 1;
    this.sequences.set(input.order_id, id);

    const event: OrderStatusEvent = { id, at: new Date().toISOString(), ...input };

    const buffer = this.buffers.get(input.order_id) ?? [];
    buffer.push(event);
    // Кільце: тримаємо хвіст, бо реконект цікавить останнє, а не вся історія.
    if (buffer.length > BUFFER_SIZE) buffer.splice(0, buffer.length - BUFFER_SIZE);
    this.buffers.set(input.order_id, buffer);

    this.logger.log(`order ${event.order_id}: ${event.previous_status} -> ${event.status} (#${id})`);
    this.subject.next(event);
    return event;
  }

  /**
   * Події цього замовлення з номером БІЛЬШИМ за lastEventId — те, що клієнт
   * пропустив, поки був відключений. lastEventId = 0 означає «з початку буфера».
   */
  replaySince(orderId: string, lastEventId: number): OrderStatusEvent[] {
    const buffer = this.buffers.get(orderId) ?? [];
    return buffer.filter((e) => e.id > lastEventId);
  }

  /** Номер останньої події замовлення — зручно для діагностики й тестів. */
  lastEventId(orderId: string): number {
    return this.sequences.get(orderId) ?? 0;
  }
}
