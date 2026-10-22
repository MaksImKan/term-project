import type { EntityManager } from 'typeorm';
import { ORDER_PLACED, OrderPlacedEvent } from '../messaging/contracts';
import type { CheckoutInput, CheckoutResult } from '../checkout';

/**
 * Запис події в outbox — у ТІЙ САМІЙ транзакції, що й бізнес-рядок.
 *
 * Чому не `publish()` просто тут: брокер не вміє відкочуватись. Якби publish
 * стояв усередині транзакції, кожен ROLLBACK лишав би назовні подію про
 * замовлення, якого не існує. А якби він стояв одразу після COMMIT — лишалося
 * б вікно, у яке вміщається падіння процесу, і замовлення жило б без події.
 * Обидві проблеми знімає один запис у ту саму базу: або є і замовлення, і
 * рядок outbox, або немає нічого.
 *
 * `manager` тут — обовʼязково менеджер ЧИННОЇ транзакції, а не DataSource:
 * транзакція живе на одному зʼєднанні з пулу, і окремий `pool.query('BEGIN')`
 * відправив би BEGIN і COMMIT у різні зʼєднання.
 */
export const AGGREGATE_ORDER = 'order';

export interface OutboxRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  type: string;
  payload: OrderPlacedEvent;
  created_at: Date;
  published_at: Date | null;
  attempts: number;
}

/**
 * Явне перетворення домену в контракт події.
 *
 * Три рядки зараз замість зламаних консюмерів потім: `{ ...order }` зробив би
 * схему БД публічним API, і перше ж перейменування колонки поїхало б у
 * чужі сервіси.
 */
export function toOrderPlacedEvent(
  result: Pick<CheckoutResult, 'orderId' | 'totalCents'>,
  input: CheckoutInput,
  currency = 'UAH',
): OrderPlacedEvent {
  return {
    // Стабільний id факту: повторне винесення тієї самої події з outbox дасть
    // рівно той самий eventId, і саме за ним консюмер упізнає дубль.
    eventId: `evt_order_placed_${result.orderId}`,
    type: ORDER_PLACED,
    occurredAt: new Date().toISOString(),
    version: 1,
    data: {
      orderId: result.orderId,
      buyerId: input.buyerId,
      productId: input.productId,
      quantity: input.quantity,
      totalCents: result.totalCents,
      currency,
    },
  };
}

/** Покласти подію в outbox. Викликається ЛИШЕ зсередини бізнес-транзакції. */
export async function enqueueEvent(
  manager: EntityManager,
  event: OrderPlacedEvent,
): Promise<string> {
  const rows = (await manager.query(
    `INSERT INTO outbox (aggregate_type, aggregate_id, type, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING id`,
    [AGGREGATE_ORDER, event.data.orderId, event.type, JSON.stringify(event)],
  )) as Array<{ id: string }>;

  return rows[0].id;
}

/** Скільки подій ще не винесено. Потрібне демо й моніторингу relay-лагу. */
export async function countUnpublished(manager: EntityManager): Promise<number> {
  const [{ count }] = (await manager.query(
    'SELECT count(*)::int AS count FROM outbox WHERE published_at IS NULL',
  )) as Array<{ count: number }>;
  return count;
}
