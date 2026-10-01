import { DataSource, DataSourceOptions } from 'typeorm';
import { buildOptions } from './data-source';
import { ORDERS, PRODUCTS, SEED_BALANCE_CENTS } from './seed';

/** Товар, на якому влаштовуємо гонку. Перший із сіду: «Шкіряні кросівки». */
export const RACE_PRODUCT_ID = PRODUCTS[0].id!;
/** Початковий stock у demo:race. Стільки ж має бути успішних checkout-ів. */
export const RACE_STOCK = 10;
/** Скільки паралельних викликів робить demo:race. */
export const RACE_ATTEMPTS = 50;

/** id замовлень із сіду — усе, що понад них, створили демо. */
const SEED_ORDER_IDS = ORDERS.map((order) => order.id!);

/**
 * Окремий DataSource із власним розміром пулу.
 *
 * 50 паралельних checkout-ів — це до 50 одночасних зʼєднань. Пул меншого
 * розміру не ламає нічого: транзакції чемно постоять у черзі пулу, і на
 * результат це не впливає. Але з pool = 1 «конкурентність» була б фікцією,
 * тож беремо запас.
 */
export async function openDataSource(poolSize: number): Promise<DataSource> {
  // Каст потрібен через те, що DataSourceOptions — union по всіх драйверах, і
  // spread розмиває дискримінант `type`. Форма обʼєкта від цього не змінюється.
  const options = { ...buildOptions(), poolSize } as DataSourceOptions;
  return new DataSource(options).initialize();
}

export interface ResetOptions {
  /** Скільком товарам виставити stock (за замовчуванням лише гоночному). */
  stock?: number;
  productId?: string;
}

/**
 * Приводить базу до відомого стану, щоб демо можна було ганяти скільки завгодно
 * разів і щоразу отримувати ті самі числа.
 *
 * Сідові рядки не чіпаємо — прибираємо лише те, що створили попередні прогони.
 */
export async function resetDemoState(
  ds: DataSource,
  options: ResetOptions = {},
): Promise<void> {
  const stock = options.stock ?? RACE_STOCK;
  const productId = options.productId ?? RACE_PRODUCT_ID;

  await ds.transaction(async (manager) => {
    // tasks і order_items ідуть за замовленнями через ON DELETE CASCADE.
    await manager.query(
      `DELETE FROM orders WHERE id <> ALL($1::bigint[])`,
      [SEED_ORDER_IDS],
    );
    await manager.query('DELETE FROM tasks');
    await manager.query('UPDATE products SET stock = $2 WHERE id = $1', [productId, stock]);
    await manager.query('UPDATE users SET balance_cents = $1', [SEED_BALANCE_CENTS]);
  });
}

/** Чи взагалі наллято базу. Без сіду демо не мають на чому працювати. */
export async function assertSeeded(ds: DataSource): Promise<void> {
  const [{ users, products }] = await ds.query<Array<{ users: string; products: string }>>(
    'SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM products) AS products',
  );
  if (Number(users) === 0 || Number(products) === 0) {
    throw new Error('База порожня. Спершу: npm run migrate && npm run seed');
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface DemoOutcome {
  ok: boolean;
  summary: string;
}

/**
 * Однаковий фінальний блок для всіх трьох демо.
 *
 * Викликається ПІСЛЯ того, як DataSource закрито: process.exit() обриває
 * процес негайно, тож із нього не варто виходити з середини try/finally —
 * пул зʼєднань лишився б незакритим.
 */
export function finish({ ok, summary }: DemoOutcome): never {
  console.log(`\n${ok ? '✔' : '✖'} ${summary}`);
  process.exit(ok ? 0 : 1);
}
