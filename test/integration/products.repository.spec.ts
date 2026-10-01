import { ProductsRepository } from '../../src/repositories/products.repository';
import { SQLSTATE, sqlstateOf, Queryable } from '../../src/repositories/types';
import { aProduct, insertProduct, insertUser } from '../support/builders';
import {
  TestDatabase,
  startTestDatabase,
  truncateAll,
  useRollbackTransaction,
} from '../support/testkit';

/**
 * ProductsRepository проти справжнього Postgres.
 *
 * Кожен тест тут перевіряє щось, чого мок не має: FK на продавця, генеровану
 * колонку search_vector із GIN-індексом, атомарний UPDATE з умовою.
 */
describe('ProductsRepository (integration)', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase();
    console.log(`  база для тестів: ${db.source}`);
    // Одна відома точка відліку на файл. У звичайному прогоні це no-op:
    // контейнер і так чистий. Потрібно це в режимі спільної БД
    // (TEST_DATABASE_URL), де в одній базі перед цим файлом могли
    // відпрацювати e2e — вони комітять, і тести з перевіркою
    // «рівно один рядок» побачили б чуже. Самої стратегії ізоляції це не
    // торкається: TRUNCATE один раз до всіх тестів, далі кожен тест у
    // транзакції й нічого не комітить.
    await truncateAll(db.pool);
  });

  afterAll(async () => {
    await db.stop();
  });

  // Ізоляція: транзакція + ROLLBACK. Нічого чистити не треба.
  const client = useRollbackTransaction(() => db.pool);
  const repo = (): ProductsRepository => new ProductsRepository(client() as unknown as Queryable);

  it('зберігає товар і читає його назад без втрати копійок', async () => {
    const sellerId = await insertUser(client() as unknown as Queryable);

    const created = await repo().insert({
      sellerId,
      ...aProduct({ priceCents: 123_456, stock: 7 }),
    });

    const found = await repo().findById(created.id);

    expect(found).not.toBeNull();
    // Гроші — integer у копійках: ніяких 123456.00000001, як було б із float.
    expect(found!.price_cents).toBe(123_456);
    expect(found!.stock).toBe(7);
    expect(found!.seller_id).toBe(sellerId);
  });

  it('повнотекстовий пошук знаходить за словоформою зі назви, але не за іншим відмінком', async () => {
    const sellerId = await insertUser(client() as unknown as Queryable);
    await insertProduct(
      client() as unknown as Queryable,
      sellerId,
      aProduct({ name: 'Шкіряні кросівки Vesna', description: 'Оригінальні шкіряні кросівки.' }),
    );
    await insertProduct(
      client() as unknown as Queryable,
      sellerId,
      aProduct({ name: 'Вовняний джемпер', description: 'Оригінальний вовняний джемпер.' }),
    );

    const hits = await repo().searchByText('шкіряні кросівки');
    expect(hits).toHaveLength(1);
    expect(hits[0].name).toContain('кросівки');

    // Поведінка цілком належить БД: конфігурація 'simple' не має стемера,
    // тож родовий відмінок не знаходить нічого. Мок відтворив би будь-яку
    // вигадану відповідь — Postgres віддає ту, що буде в проді.
    const otherCase = await repo().searchByText('кросівок');
    expect(otherCase).toHaveLength(0);
  });

  it('декремент залишку атомарний: не віддає товар, якого немає', async () => {
    const sellerId = await insertUser(client() as unknown as Queryable);
    const productId = await insertProduct(
      client() as unknown as Queryable,
      sellerId,
      aProduct({ stock: 3 }),
    );

    const ok = await repo().decrementStock(productId, 3);
    expect(ok).not.toBeNull();
    expect(ok!.stock).toBe(0);

    // Умова WHERE stock >= $n і є перевіркою: нуль рядків означає «немає».
    const tooMuch = await repo().decrementStock(productId, 1);
    expect(tooMuch).toBeNull();

    const after = await repo().findById(productId);
    expect(after!.stock).toBe(0);
  });

  it('не дає створити товар неіснуючого продавця (FK, 23503)', async () => {
    // Констрейнт живе в БД — у коді репозиторію такої перевірки немає взагалі,
    // і саме тому мок цей кейс пропустив би.
    const error = await repo()
      .insert({ sellerId: '999999999', ...aProduct() })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).not.toBeNull();
    expect(sqlstateOf(error)).toBe(SQLSTATE.FOREIGN_KEY_VIOLATION);
    expect((error as Error).message).toMatch(/foreign key constraint/i);
  });

  it('не дає нульову або відʼємну ціну (CHECK, 23514)', async () => {
    const sellerId = await insertUser(client() as unknown as Queryable);

    const error = await repo()
      .insert({ sellerId, ...aProduct({ priceCents: 0 }) })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(sqlstateOf(error)).toBe(SQLSTATE.CHECK_VIOLATION);
    expect((error as Error).message).toMatch(/products_price_positive/);
  });
});
