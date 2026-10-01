import { OrdersRepository } from '../../src/repositories/orders.repository';
import { SQLSTATE, sqlstateOf, Queryable } from '../../src/repositories/types';
import { aProduct, aUser, anOrder, insertProduct, insertUser } from '../support/builders';
import {
  TestDatabase,
  startTestDatabase,
  truncateAll,
  useRollbackTransaction,
} from '../support/testkit';

/**
 * OrdersRepository проти справжнього Postgres: JOIN із агрегацією позицій,
 * звіт із GROUP BY і два констрейнти, яких немає в коді — лише в схемі.
 */
describe('OrdersRepository (integration)', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase();
    // Відома точка відліку на файл — див. пояснення у
    // products.repository.spec.ts. У режимі testcontainers це no-op.
    await truncateAll(db.pool);
  });

  afterAll(async () => {
    await db.stop();
  });

  const client = useRollbackTransaction(() => db.pool);
  const q = (): Queryable => client() as unknown as Queryable;
  const repo = (): OrdersRepository => new OrdersRepository(q());

  it('склеює замовлення з позиціями одним запитом (JOIN + json_agg)', async () => {
    const buyerId = await insertUser(q());
    const sellerId = await insertUser(q());
    const shoes = await insertProduct(q(), sellerId, aProduct({ name: 'Шкіряні кросівки' }));
    const bag = await insertProduct(q(), sellerId, aProduct({ name: 'Шкіряна сумка' }));

    const order = await repo().create(buyerId, anOrder().status);
    await repo().addItem(order.id, shoes, 2, 249_900);
    await repo().addItem(order.id, bag, 1, 189_900);
    const total = await repo().recalculateTotal(order.id);

    const found = await repo().findWithItems(order.id);

    expect(found).not.toBeNull();
    expect(found!.items).toHaveLength(2);
    // Назва товару приїхала з другої таблиці — це і є те, що перевіряє JOIN.
    expect(found!.items.map((i) => i.product_name).sort()).toEqual([
      'Шкіряна сумка',
      'Шкіряні кросівки',
    ]);
    expect(total).toBe(2 * 249_900 + 189_900);
    expect(found!.total_cents).toBe(total);
  });

  it('віддає замовлення без позицій із порожнім масивом, а не з null-рядком', async () => {
    const buyerId = await insertUser(q());
    const order = await repo().create(buyerId);

    const found = await repo().findWithItems(order.id);

    // LEFT JOIN + FILTER (WHERE oi.id IS NOT NULL): без FILTER тут приїхав би
    // масив з одного json-обʼєкта, набитого null-ами.
    expect(found!.items).toEqual([]);
    expect(found!.total_cents).toBe(0);
  });

  it('агрегує виторг по продавцях і рахує лише оплачені замовлення (GROUP BY)', async () => {
    const buyerId = await insertUser(q());
    const seller = await insertUser(q(), aUser({ fullName: 'Ірина Бондаренко' }));
    const other = await insertUser(q(), aUser({ fullName: 'Андрій Коваленко' }));

    const sellerProduct = await insertProduct(q(), seller, aProduct({ priceCents: 100_000 }));
    const otherProduct = await insertProduct(q(), other, aProduct({ priceCents: 50_000 }));

    const paid = await repo().create(buyerId, 'paid');
    await repo().addItem(paid.id, sellerProduct, 3, 100_000);
    await repo().addItem(paid.id, otherProduct, 1, 50_000);

    // Скасоване замовлення у виторг не входить — цю умову перевіряє WHERE.
    const cancelled = await repo().create(buyerId, 'cancelled');
    await repo().addItem(cancelled.id, sellerProduct, 10, 100_000);

    const report = await repo().revenueBySeller();

    expect(report).toHaveLength(2);
    expect(report[0].seller_name).toBe('Ірина Бондаренко');
    // Агрегати приходять рядками: COUNT/SUM у Postgres це bigint/numeric.
    expect(report[0].revenue_cents).toBe(String(3 * 100_000));
    expect(report[0].units_sold).toBe('3');
    expect(report[0].orders_count).toBe('1');
    expect(report[1].revenue_cents).toBe(String(50_000));
  });

  it('не дає двічі додати той самий товар у замовлення (UNIQUE, 23505)', async () => {
    const buyerId = await insertUser(q());
    const sellerId = await insertUser(q());
    const productId = await insertProduct(q(), sellerId, aProduct());
    const order = await repo().create(buyerId);

    await repo().addItem(order.id, productId, 1, 249_900);

    const error = await repo()
      .addItem(order.id, productId, 1, 249_900)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(sqlstateOf(error)).toBe(SQLSTATE.UNIQUE_VIOLATION);
    expect((error as Error).message).toMatch(/duplicate key value violates unique constraint/i);
    expect((error as Error).message).toMatch(/order_items_one_row_per_product/);
  });

  it('не дає замовлення неіснуючому покупцю (FK, 23503)', async () => {
    const error = await repo()
      .create('999999999')
      .then(() => null)
      .catch((e: unknown) => e);

    expect(sqlstateOf(error)).toBe(SQLSTATE.FOREIGN_KEY_VIOLATION);
  });
});
