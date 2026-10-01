import 'reflect-metadata';
import { CheckoutError, checkout } from './checkout';
import type { DemoOutcome } from './demo-support';
import {
  RACE_ATTEMPTS,
  RACE_PRODUCT_ID,
  RACE_STOCK,
  assertSeeded,
  finish,
  openDataSource,
  resetDemoState,
} from './demo-support';
import { USERS } from './seed';

/**
 * Конкурентний шквал: 50 паралельних checkout-ів на один товар зі stock = 10.
 *
 *   npm run demo:race
 *
 * Жодних черг у застосунку — чистий Promise.all. Обмежувати має САМЕ stock,
 * тому баланси в сіді свідомо надлишкові: якби не вистачало грошей, число
 * успішних залежало б від того, хто перший дійшов до гаманця, і перестало б
 * бути детермінованим.
 *
 * Інваріант, який скрипт перевіряє сам:
 *   успішних = початковий stock (при qty = 1),
 *   фінальний stock = 0,
 *   рядків із відʼємним stock = 0.
 */

const QUANTITY = 1;

async function main(): Promise<DemoOutcome> {
  // Пул з запасом: 50 транзакцій хочуть 50 зʼєднань одночасно.
  const ds = await openDataSource(RACE_ATTEMPTS + 5);

  try {
    await assertSeeded(ds);
    await resetDemoState(ds, { stock: RACE_STOCK, productId: RACE_PRODUCT_ID });

    const buyerIds = USERS.map((user) => user.id!);
    const [{ stock: stockBefore }] = await ds.query<Array<{ stock: number }>>(
      'SELECT stock FROM products WHERE id = $1',
      [RACE_PRODUCT_ID],
    );

    console.log('── demo:race ──');
    console.log(`товар ${RACE_PRODUCT_ID}, stock на старті: ${stockBefore}`);
    console.log(`паралельних викликів: ${RACE_ATTEMPTS}, по ${QUANTITY} од. кожен`);
    console.log(`покупців у ротації: ${buyerIds.length} (баланси надлишкові)\n`);

    const startedAt = Date.now();

    // Ось воно: жодного awaiting у циклі, усі 50 стартують разом.
    const settled = await Promise.allSettled(
      Array.from({ length: RACE_ATTEMPTS }, (_, i) =>
        checkout(ds, {
          buyerId: buyerIds[i % buyerIds.length],
          productId: RACE_PRODUCT_ID,
          quantity: QUANTITY,
        }),
      ),
    );

    const elapsedMs = Date.now() - startedAt;

    const succeeded = settled.filter((r) => r.status === 'fulfilled').length;
    const failures = new Map<string, number>();
    for (const result of settled) {
      if (result.status === 'rejected') {
        const reason =
          result.reason instanceof CheckoutError
            ? result.reason.reason
            : `unexpected: ${(result.reason as Error).message.split('\n')[0]}`;
        failures.set(reason, (failures.get(reason) ?? 0) + 1);
      }
    }

    const [{ stock: stockAfter }] = await ds.query<Array<{ stock: number }>>(
      'SELECT stock FROM products WHERE id = $1',
      [RACE_PRODUCT_ID],
    );
    const [{ negative }] = await ds.query<Array<{ negative: string }>>(
      'SELECT count(*) AS negative FROM products WHERE stock < 0',
    );
    // Рахуємо лише те, що створив цей прогін: у сіді вже є замовлення на цей
    // самий товар, і якби ми рахували всі order_items по product_id, число
    // ніколи не зійшлося б із кількістю успішних.
    const [{ orders, items, tasks }] = await ds.query<
      Array<{ orders: string; items: string; tasks: string }>
    >(`SELECT (SELECT count(*)          FROM tasks) AS tasks,
              (SELECT count(DISTINCT o.id) FROM orders o JOIN tasks t ON t.order_id = o.id) AS orders,
              (SELECT count(*)          FROM order_items oi JOIN tasks t ON t.order_id = oi.order_id
                                        WHERE oi.product_id = $1) AS items`,
      [RACE_PRODUCT_ID],
    );

    console.table({
      'спроб': RACE_ATTEMPTS,
      'успішних': succeeded,
      'фінальний stock': Number(stockAfter),
      'рядків із відʼємним stock': Number(negative),
      'задач у черзі': Number(tasks),
      'час, мс': elapsedMs,
    });

    if (failures.size > 0) {
      console.log('Відмови (транзакція відкотилась цілою):');
      for (const [reason, count] of [...failures].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${reason}: ${count}`);
      }
    }

    // ── перевірка інваріанта ──
    const problems: string[] = [];
    if (succeeded !== stockBefore) {
      problems.push(`успішних ${succeeded}, а мало бути ${stockBefore} (= початковий stock)`);
    }
    if (Number(stockAfter) !== 0) problems.push(`фінальний stock ${stockAfter}, а мало бути 0`);
    if (Number(negative) !== 0) problems.push(`є ${negative} рядків із відʼємним stock — oversell`);
    // Задач і позицій має бути рівно стільько ж, скільки успішних замовлень:
    // це перевірка, що «сиріт» немає в жодному напрямку.
    if (Number(tasks) !== succeeded) {
      problems.push(`задач ${tasks}, успішних ${succeeded} — задача створюється не в тій транзакції`);
    }
    if (Number(items) !== succeeded) {
      problems.push(`позицій замовлень ${items}, успішних ${succeeded}`);
    }
    if (Number(orders) !== succeeded) {
      problems.push(`замовлень ${orders}, успішних ${succeeded} — є замовлення-«сироти»`);
    }

    if (problems.length > 0) {
      for (const problem of problems) console.error(`  ✖ ${problem}`);
      return { ok: false, summary: 'інваріант порушено: oversell або втрачений апдейт' };
    }

    return {
      ok: true,
      summary:
        `oversell не стався: ${succeeded} успішних із ${RACE_ATTEMPTS}, stock 0, відʼємних 0, ` +
        `${tasks} задач у черзі`,
    };
  } finally {
    await ds.destroy().catch(() => undefined);
  }
}

main()
  .then(finish)
  .catch((error: unknown) => {
    console.error('\n✖ demo:race не відпрацював.\n');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
