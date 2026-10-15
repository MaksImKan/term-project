import type { DataSource } from 'typeorm';
import { OrderPlacedEvent } from './contracts';

export type EffectOutcome = 'applied' | 'duplicate';

/**
 * Ефект споживача: складське завдання зібрати замовлення.
 *
 * Уся ідемпотентність тут — у `ON CONFLICT (eventId) DO NOTHING`. Це
 * найдешевша КОРЕКТНА форма: ефект виражений через природний ключ, тож
 * повторна доставка не подвоює роботу й не потребує окремого сховища
 * оброблених id. Порівняйте з `UPDATE … SET qty = qty - 1` — така операція не
 * ідемпотентна в принципі, і для неї довелося б вести ключі ідемпотентності
 * окремо.
 *
 * Нуль вставлених рядків — це не помилка, а відповідь «цю подію вже
 * обробляли»: саме її споживач рахує як skipped.
 *
 * Межа, яку це ДЗ не закриває: між «ефект застосовано» і «ack надіслано» є
 * щілина, і падіння в ній дає повторну доставку (її й показує demo:duplicate).
 * Зворотну щілину — «позначку поставлено, ефекту немає» — закриває не менша
 * щілина, а спільна транзакція позначки й ефекту; це ДЗ-22 (outbox).
 */
export async function applyPickingTask(
  dataSource: DataSource,
  event: OrderPlacedEvent,
): Promise<EffectOutcome> {
  const rows = (await dataSource.query(
    `INSERT INTO picking_tasks ("eventId", order_id, quantity)
     VALUES ($1, $2, $3)
     ON CONFLICT ("eventId") DO NOTHING
     RETURNING id`,
    [event.eventId, event.data.orderId, event.data.quantity],
  )) as Array<{ id: string }>;

  return rows.length > 0 ? 'applied' : 'duplicate';
}

/** Скільки подій уже дали ефект. Рахуємо ПОДІЇ, а не рядки похідних таблиць. */
export async function countAppliedEffects(dataSource: DataSource): Promise<number> {
  const [{ count }] = (await dataSource.query(
    'SELECT count(DISTINCT "eventId")::int AS count FROM picking_tasks',
  )) as Array<{ count: number }>;
  return count;
}

/** Прибрати ефекти попередніх прогонів — кожне демо стартує з чистого аркуша. */
export async function resetEffects(dataSource: DataSource): Promise<void> {
  await dataSource.query('DELETE FROM picking_tasks');
}
