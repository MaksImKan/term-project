import type { DataSource, EntityManager } from 'typeorm';
import { CheckoutInput, CheckoutResult, checkoutInTransaction } from '../checkout';
import { enqueueEvent, toOrderPlacedEvent } from './outbox';

/**
 * Оформлення замовлення — критична бізнес-операція курсового, тепер цілком
 * усередині ОДНОГО COMMIT разом зі своєю подією.
 *
 * В одній транзакції відбувається:
 *   1) claim ключа ідемпотентності (рівень 3);
 *   2) декремент stock, списання балансу, INSERT замовлення, позицій і задачі
 *      post-processing — усе те, що робив checkout із ДЗ-14;
 *   3) INSERT рядка в outbox;
 *   4) привʼязка ключа до створеного замовлення.
 *
 * Жодного publish тут немає й бути не може: брокер не вміє відкочуватись, а
 * COMMIT спільного для Postgres і RabbitMQ не існує. Назовні подію виносить
 * relay — окремо і пізніше.
 */

export interface PlaceOrderResult extends CheckoutResult {
  /** Чи це повтор запиту з тим самим ключем (замовлення не створювалось). */
  replay: boolean;
  /** id рядка в outbox. Для повтору — id рядка, створеного першим запитом. */
  outboxId: string | null;
}

/** Точка, у якій demo:crash-write валить транзакцію — ПІСЛЯ вставки в outbox. */
export type AfterEnqueueHook = (manager: EntityManager) => Promise<void> | void;

export interface PlaceOrderOptions {
  afterEnqueue?: AfterEnqueueHook;
}

/**
 * Ключ ідемпотентності ідентифікує НАМІР, а не тіло запиту.
 *
 * Хеш тіла тут був би помилкою: два легітимні однакові замовлення (клієнт
 * справді хоче другу пару тих самих кросівок) схлопнулись би в одне. І
 * навпаки — ключ без тіла дозволяє серверу віддати на повтор саме ту
 * відповідь, що й першого разу, не вгадуючи наміру.
 *
 * Сховище ключа — та сама база, що й замовлення, і claim іде в тій самій
 * транзакції. Ключ у памʼяті процесу (як у стабі ДЗ-09) помер би разом із
 * процесом і не існував би між двома репліками.
 */
export async function placeOrder(
  dataSource: DataSource,
  idempotencyKey: string,
  input: CheckoutInput,
  options: PlaceOrderOptions = {},
): Promise<PlaceOrderResult> {
  return dataSource.transaction(async (manager) => {
    // ON CONFLICT DO NOTHING, а не SELECT-потім-INSERT: перевірка і захоплення
    // одним висловом, без вікна між ними. Якщо інший запит із тим самим ключем
    // ще в польоті, цей вислів чекає на його COMMIT — і бачить готовий рядок.
    const claimed = (await manager.query(
      `INSERT INTO idempotency_keys ("key") VALUES ($1)
       ON CONFLICT ("key") DO NOTHING
       RETURNING "key"`,
      [idempotencyKey],
    )) as Array<{ key: string }>;

    if (claimed.length === 0) {
      return replayOf(manager, idempotencyKey);
    }

    const result = await checkoutInTransaction(manager, input);

    const event = toOrderPlacedEvent(result, input);
    const outboxId = await enqueueEvent(manager, event);

    // Хук demo:crash-write. Він кидає ПІСЛЯ того, як рядок outbox уже
    // вставлено, — щоб було видно, що зникають обидва рядки, а не лише один.
    await options.afterEnqueue?.(manager);

    await manager.query('UPDATE idempotency_keys SET order_id = $2 WHERE "key" = $1', [
      idempotencyKey,
      result.orderId,
    ]);

    return { ...result, replay: false, outboxId };
  });
}

/** Відповідь на повтор: те саме замовлення, без другого ефекту. */
async function replayOf(
  manager: EntityManager,
  idempotencyKey: string,
): Promise<PlaceOrderResult> {
  const rows = (await manager.query(
    `SELECT k.order_id,
            o.total_cents,
            (SELECT id FROM outbox WHERE aggregate_id = k.order_id::text ORDER BY id LIMIT 1) AS outbox_id,
            (SELECT id FROM tasks  WHERE order_id = k.order_id        ORDER BY id LIMIT 1) AS task_id,
            (SELECT stock FROM products p JOIN order_items i ON i.product_id = p.id
              WHERE i.order_id = k.order_id LIMIT 1) AS stock_left,
            (SELECT balance_cents FROM users u WHERE u.id = o.buyer_id) AS balance_left
       FROM idempotency_keys k
       JOIN orders o ON o.id = k.order_id
      WHERE k."key" = $1`,
    [idempotencyKey],
  )) as Array<{
    order_id: string;
    total_cents: number;
    outbox_id: string | null;
    task_id: string | null;
    stock_left: number | null;
    balance_left: number | null;
  }>;

  if (rows.length === 0) {
    // Ключ є, а замовлення немає: перший запит упав уже після claim. Чесно
    // кажемо про це замість того, щоб вигадувати відповідь.
    throw new Error(
      `ключ ${idempotencyKey} уже використано, але замовлення за ним немає — ` +
        'перший запит не завершився; повторіть з новим ключем',
    );
  }

  const row = rows[0];
  return {
    orderId: row.order_id,
    taskId: row.task_id ?? '',
    totalCents: row.total_cents,
    stockLeft: row.stock_left ?? 0,
    balanceLeft: row.balance_left ?? 0,
    replay: true,
    outboxId: row.outbox_id,
  };
}
