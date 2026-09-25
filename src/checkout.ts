import { DataSource, EntityManager } from 'typeorm';

/**
 * Ключова бізнес-операція домену: оформлення замовлення.
 *
 * Одна транзакція — чотири зміни, які не мають права розʼїхатись:
 *   1) декремент stock товару;
 *   2) списання балансу покупця;
 *   3) INSERT замовлення + позиції;
 *   4) INSERT задачі на post-processing (лист/чек) у outbox-чергу.
 *
 * Не вистачило товару або грошей — відкочується ВСЕ. Замовлень-«сиріт» без
 * списаних грошей, як і списань без замовлення, не існує за побудовою.
 *
 * ── Чому атомарний UPDATE, а не SELECT … FOR UPDATE ───────────────────────
 *
 * Обидва варіанти коректні, але тут вибрано атомарний
 *
 *     UPDATE products SET stock = stock - $n WHERE id = $1 AND stock >= $n
 *     RETURNING …
 *
 * бо він робить перевірку і зміну ОДНИМ висловом: між «чи є 3 штуки» і «мінус
 * 3 штуки» немає вікна, у яке вклиниться інша транзакція. Postgres бере
 * рядковий лок сам, а `RETURNING` заразом повертає ціну — тобто нуль рядків у
 * відповіді вже означає «товару немає», і окремий SELECT не потрібен.
 *
 * `SELECT … FOR UPDATE` знадобився б, якби між читанням і записом треба було
 * прийняти рішення, яке не виражається в WHERE: наприклад порахувати скидку за
 * історією покупця або звіритися із зовнішнім сервісом. Тоді лок тримає рядок,
 * поки логіка думає. Ціна — довший лок і зайвий round-trip; тут вони ні за що.
 *
 * Порядок локів однаковий у всіх викликах (спершу товар, потім покупець) —
 * саме тому 50 паралельних checkout-ів не дають дедлоку.
 */

export type CheckoutFailure = 'out_of_stock' | 'insufficient_funds' | 'no_such_product' | 'no_such_buyer';

export class CheckoutError extends Error {
  constructor(
    readonly reason: CheckoutFailure,
    message: string,
  ) {
    super(message);
    this.name = 'CheckoutError';
  }
}

export interface CheckoutInput {
  buyerId: string;
  productId: string;
  quantity: number;
}

export interface CheckoutResult {
  orderId: string;
  taskId: string;
  totalCents: number;
  stockLeft: number;
  balanceLeft: number;
}

/**
 * TypeORM-граблі, на які легко наступити: `manager.query()` повертає різне
 * залежно від команди. Для SELECT та INSERT … RETURNING це масив рядків, а для
 * UPDATE та DELETE — пара `[rows, affectedCount]`. Тобто `rows.length` після
 * UPDATE … RETURNING завжди 2, а `rows[0]` — не рядок, а вкладений масив.
 * Перевірка «нуль рядків = товару немає» на такому результаті ніколи не
 * спрацювала б, а ціна прийшла б як undefined.
 */
function rowsOf<T>(raw: unknown): T[] {
  if (
    Array.isArray(raw) &&
    raw.length === 2 &&
    Array.isArray(raw[0]) &&
    typeof raw[1] === 'number'
  ) {
    return raw[0] as T[];
  }
  return (raw ?? []) as T[];
}

interface StockRow {
  id: string;
  price_cents: number;
  currency: string;
  stock: number;
}

/** Тіло операції; окремо від транзакції, щоб його можна було віддати в retry. */
export async function checkoutInTransaction(
  manager: EntityManager,
  { buyerId, productId, quantity }: CheckoutInput,
): Promise<CheckoutResult> {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new CheckoutError('out_of_stock', `quantity має бути цілим > 0, отримано ${quantity}`);
  }

  // 1) Атомарний декремент: перевірка й зміна в одному вислові.
  //    Нуль рядків у відповіді = або товару немає взагалі, або не вистачає.
  const stock = rowsOf<StockRow>(
    await manager.query(
      `UPDATE products
        SET stock = stock - $2
      WHERE id = $1
        AND stock >= $2
      RETURNING id, price_cents, currency, stock`,
      [productId, quantity],
    ),
  );

  if (stock.length === 0) {
    const exists = rowsOf<{ stock: number }>(
      await manager.query('SELECT stock FROM products WHERE id = $1', [productId]),
    );
    if (exists.length === 0) {
      throw new CheckoutError('no_such_product', `товару ${productId} не існує`);
    }
    throw new CheckoutError(
      'out_of_stock',
      `товару ${productId}: треба ${quantity}, лишилось ${exists[0].stock}`,
    );
  }

  const { price_cents: unitPriceCents, currency, stock: stockLeft } = stock[0];
  const totalCents = unitPriceCents * quantity;

  // 2) Так само атомарне списання балансу.
  const wallet = rowsOf<{ balance_cents: number }>(
    await manager.query(
      `UPDATE users
        SET balance_cents = balance_cents - $2
      WHERE id = $1
        AND balance_cents >= $2
      RETURNING balance_cents`,
      [buyerId, totalCents],
    ),
  );

  if (wallet.length === 0) {
    const exists = rowsOf<{ balance_cents: number }>(
      await manager.query('SELECT balance_cents FROM users WHERE id = $1', [buyerId]),
    );
    if (exists.length === 0) {
      throw new CheckoutError('no_such_buyer', `покупця ${buyerId} не існує`);
    }
    // Кидаємо — і декремент stock з кроку 1 відкотиться разом із транзакцією.
    throw new CheckoutError(
      'insufficient_funds',
      `покупцю ${buyerId} треба ${totalCents}, на балансі ${exists[0].balance_cents}`,
    );
  }

  // 3) Замовлення. paid_at = created_at, інакше спрацював би CHECK
  //    orders_paid_at_sane.
  const order = rowsOf<{ id: string }>(
    await manager.query(
      `INSERT INTO orders (buyer_id, status, total_cents, currency, created_at, paid_at)
     VALUES ($1, 'paid', $2, $3, now(), now())
     RETURNING id`,
      [buyerId, totalCents, currency],
    ),
  );
  const orderId = order[0].id;

  await manager.query(
    `INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents)
     VALUES ($1, $2, $3, $4)`,
    [orderId, productId, quantity, unitPriceCents],
  );

  // 4) Задача на post-processing — у ТІЙ САМІЙ транзакції (outbox).
  //    Сама задача виконується окремо, воркерами: src/demo-workers.ts.
  const task = rowsOf<{ id: string }>(
    await manager.query(
      `INSERT INTO tasks (type, payload, order_id)
     VALUES ('order.receipt', $1::jsonb, $2)
     RETURNING id`,
      [JSON.stringify({ orderId, buyerId, productId, quantity, totalCents }), orderId],
    ),
  );

  return {
    orderId,
    taskId: task[0].id,
    totalCents,
    stockLeft,
    balanceLeft: wallet[0].balance_cents,
  };
}

/** Публічна операція: та сама логіка, обгорнута в одну транзакцію. */
export async function checkout(
  dataSource: DataSource,
  input: CheckoutInput,
): Promise<CheckoutResult> {
  // dataSource.transaction() бере ОДНЕ зʼєднання з пулу і тримає його до
  // COMMIT. Якби BEGIN і COMMIT відправлялись через pool.query(), вони могли
  // б поїхати в різні зʼєднання — і транзакції не було б узагалі.
  return dataSource.transaction((manager) => checkoutInTransaction(manager, input));
}
