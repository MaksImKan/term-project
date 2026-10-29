import type { DataSource } from 'typeorm';

/**
 * «Важке» читання домену: картка товару з рейтингом, залишком і продажами.
 *
 * Чому воно дороге насправді, а не для вигляду: три агрегати по трьох
 * таблицях, із яких `order_items` росте разом з історією замовлень. Кожен
 * такий виклик — це кілька сканувань, і саме його має сенс тримати в кеші.
 *
 * `dbCalls` рахується ТУТ, у репозиторії, а не на рівні «скільки разів я
 * викликав функцію»: лічильник інкрементиться рівно в тому місці, де
 * відправляється SQL. Саме це число і є весь сенс single-flight лока.
 */
export interface ProductCard {
  id: string;
  name: string;
  priceCents: number;
  currency: string;
  stock: number;
  ordersCount: number;
  unitsSold: number;
}

export class ProductCardRepository {
  private calls = 0;

  constructor(private readonly dataSource: DataSource) {}

  /** Скільки РЕАЛЬНИХ запитів пішло в базу від створення репозиторію. */
  get dbCalls(): number {
    return this.calls;
  }

  resetCounter(): void {
    this.calls = 0;
  }

  async load(productId: string): Promise<ProductCard | null> {
    this.calls += 1;

    const rows = (await this.dataSource.query(
      `SELECT p.id,
              p.name,
              p.price_cents,
              p.currency,
              p.stock,
              count(DISTINCT oi.order_id)::int        AS orders_count,
              COALESCE(sum(oi.quantity), 0)::int      AS units_sold
         FROM products p
         LEFT JOIN order_items oi ON oi.product_id = p.id
         LEFT JOIN orders o       ON o.id = oi.order_id AND o.status <> 'cancelled'
        WHERE p.id = $1
        GROUP BY p.id, p.name, p.price_cents, p.currency, p.stock`,
      [productId],
    )) as Array<{
      id: string;
      name: string;
      price_cents: number;
      currency: string;
      stock: number;
      orders_count: number;
      units_sold: number;
    }>;

    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: row.id,
      name: row.name,
      priceCents: row.price_cents,
      currency: row.currency,
      stock: row.stock,
      ordersCount: row.orders_count,
      unitsSold: row.units_sold,
    };
  }
}

/** Ключ кеша. Версія в імені — щоб зміна форми payload не ламала старі записи. */
export function cardKey(productId: string): string {
  return `card:v1:${productId}`;
}
