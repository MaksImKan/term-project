import { Queryable } from './types';

export interface ProductRow extends Record<string, unknown> {
  id: string;
  seller_id: string;
  name: string;
  description: string;
  price_cents: number;
  currency: string;
  stock: number;
  is_published: boolean;
}

export interface NewProduct {
  sellerId: string;
  name: string;
  description: string;
  priceCents: number;
  currency?: string;
  stock?: number;
  isPublished?: boolean;
}

export interface SearchHit extends Record<string, unknown> {
  id: string;
  name: string;
  rank: number;
}

const COLUMNS = 'id, seller_id, name, description, price_cents, currency, stock, is_published';

/**
 * Доступ до каталогу. Уся SQL тут — і саме тому її має сенс тестувати проти
 * справжнього Postgres, а не проти мока: генерована колонка `search_vector`,
 * GIN-індекс, атомарний UPDATE з умовою і FK на продавця живуть у БД, а не в
 * цьому файлі.
 */
export class ProductsRepository {
  constructor(private readonly db: Queryable) {}

  async insert(input: NewProduct): Promise<ProductRow> {
    const { rows } = await this.db.query<ProductRow>(
      `INSERT INTO products (seller_id, name, description, price_cents, currency, stock, is_published)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${COLUMNS}`,
      [
        input.sellerId,
        input.name,
        input.description,
        input.priceCents,
        input.currency ?? 'UAH',
        input.stock ?? 0,
        input.isPublished ?? true,
      ],
    );
    return rows[0];
  }

  /** Сторінка каталогу — те, що віддає GET /products. */
  async listPage(limit: number, offset: number): Promise<ProductRow[]> {
    const { rows } = await this.db.query<ProductRow>(
      `SELECT ${COLUMNS} FROM products ORDER BY products.id LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return rows;
  }

  async findById(id: string): Promise<ProductRow | null> {
    const { rows } = await this.db.query<ProductRow>(
      `SELECT ${COLUMNS} FROM products WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * Повнотекстовий пошук по каталогу — той самий запит, що в q4 з ДЗ-12.
   * Поведінка цілком належить БД: `search_vector` генерується з name та
   * description, а конфігурація `simple` не має стемера, тож інша словоформа
   * не знаходиться. Жоден мок такого не відтворить.
   */
  async searchByText(query: string, limit = 20): Promise<SearchHit[]> {
    const { rows } = await this.db.query<SearchHit>(
      `SELECT id, name, ts_rank(search_vector, plainto_tsquery('simple', $1)) AS rank
         FROM products
        WHERE search_vector @@ plainto_tsquery('simple', $1)
        ORDER BY rank DESC, id
        LIMIT $2`,
      [query, limit],
    );
    return rows;
  }

  /**
   * Атомарний декремент залишку: перевірка й зміна одним висловом.
   * Повертає null, якщо товару стільки немає — саме так це працює у checkout.
   */
  async decrementStock(id: string, quantity: number): Promise<ProductRow | null> {
    const { rows } = await this.db.query<ProductRow>(
      `UPDATE products
          SET stock = stock - $2
        WHERE id = $1 AND stock >= $2
        RETURNING ${COLUMNS}`,
      [id, quantity],
    );
    return rows[0] ?? null;
  }

  async countPublished(): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      'SELECT count(*) AS count FROM products WHERE is_published',
    );
    return Number(rows[0].count);
  }
}
