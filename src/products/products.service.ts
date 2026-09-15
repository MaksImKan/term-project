import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ListQuery, Page, Product } from '../models';
import { encodeCursor, decodeCursor } from '../common/pagination';
import { DatabaseService } from '../db/database.service';
import { Env } from '../config/env.schema';

/**
 * Каталог живе у Postgres — саме цей шлях перевіряє критерій ротації:
 * після зміни пароля запит, що ходить у БД, має далі віддавати 200.
 */
@Injectable()
export class ProductsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async list(query: ListQuery): Promise<Page<Product>> {
    const limit =
      query.limit === undefined
        ? this.config.get('DEFAULT_PAGE_LIMIT', { infer: true })
        : Number(query.limit);
    const offset = decodeCursor(query.cursor);

    // limit + 1 — щоб дізнатися, чи є наступна сторінка, без окремого COUNT.
    const { rows } = await this.db.query<Product>(
      'SELECT id, name, price_cents, currency FROM products ORDER BY id LIMIT $1 OFFSET $2',
      [limit + 1, offset],
    );

    const hasMore = rows.length > limit;
    return {
      items: hasMore ? rows.slice(0, limit) : rows,
      next_cursor: hasMore ? encodeCursor(offset + limit) : null,
    };
  }

  async findOne(id: string): Promise<Product> {
    const product = await this.findRaw(id);
    if (!product) throw new NotFoundException(`product not found: ${id}`);
    return product;
  }

  // Для розрахунку суми замовлення.
  async findRaw(id: string): Promise<Product | undefined> {
    const { rows } = await this.db.query<Product>(
      'SELECT id, name, price_cents, currency FROM products WHERE id = $1',
      [id],
    );
    return rows[0];
  }
}
