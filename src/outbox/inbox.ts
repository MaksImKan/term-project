import type { DataSource, EntityManager } from 'typeorm';
import { OrderPlacedEvent } from '../messaging/contracts';

export type InboxOutcome = 'applied' | 'duplicate';

/** Імʼя консюмера в inbox: одна подія може бути оброблена кількома різними. */
export const PICKING_CONSUMER = 'picking';

/**
 * Ідемпотентний ефект, два рівні одразу.
 *
 * Рівень 1 — природний ключ: сам ефект висловлений так, що повтор нічого не
 * змінює. `INSERT INTO picking_tasks … ON CONFLICT ("eventId") DO NOTHING`
 * ідемпотентний за побудовою, на відміну від `UPDATE qty = qty - 1`, який на
 * другій доставці зняв би вдвічі.
 *
 * Рівень 2 — inbox: рядок у processed_messages (message_id, consumer).
 * Потрібен тому, що природний ключ є не в кожного ефекту: надіслати лист або
 * смикнути чужий API через ON CONFLICT не виразиш.
 *
 * Критичне тут — ОДНА транзакція на позначку й ефект. Позначити в Redis, а
 * ефект записати в Postgres — це той самий dual write, від якого ми тікали,
 * тільки перенесений на консюмера: падіння між двома записами лишає подію
 * «обробленою» без ефекту, і повтор її вже не врятує.
 */
export async function applyWithInbox(
  dataSource: DataSource,
  event: OrderPlacedEvent,
  consumer = PICKING_CONSUMER,
): Promise<InboxOutcome> {
  return dataSource.transaction(async (manager: EntityManager) => {
    const claimed = (await manager.query(
      `INSERT INTO processed_messages (message_id, consumer)
       VALUES ($1, $2)
       ON CONFLICT (message_id, consumer) DO NOTHING
       RETURNING message_id`,
      [event.eventId, consumer],
    )) as Array<{ message_id: string }>;

    // Рядок уже був — цю подію цей консюмер обробляв. Виходимо до ефекту.
    if (claimed.length === 0) return 'duplicate';

    await applyEffect(manager, event);
    return 'applied';
  });
}

/** Сам ефект. Винесено окремо, щоб було видно: він ідемпотентний і без inbox. */
async function applyEffect(manager: EntityManager, event: OrderPlacedEvent): Promise<void> {
  await manager.query(
    `INSERT INTO picking_tasks ("eventId", order_id, quantity)
     VALUES ($1, $2, $3)
     ON CONFLICT ("eventId") DO NOTHING`,
    [event.eventId, event.data.orderId, event.data.quantity],
  );
}

/** Скільки ПОДІЙ оброблено цим консюмером (а не скільки рядків це породило). */
export async function countProcessed(
  dataSource: DataSource,
  consumer = PICKING_CONSUMER,
): Promise<number> {
  const [{ count }] = (await dataSource.query(
    'SELECT count(*)::int AS count FROM processed_messages WHERE consumer = $1',
    [consumer],
  )) as Array<{ count: number }>;
  return count;
}
