import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ListQuery, Page, Product } from '../models';
import { encodeCursor, decodeCursor } from '../common/pagination';
import { DatabaseService } from '../db/database.service';
import { Env } from '../config/env.schema';

/**
 * Каталог живе у Postgres (db/schema.sql, таблиця products).
 *
 * Два місця, де схема БД і контракт API розходяться свідомо, тож мапінг стоїть
 * тут, у SQL, і не протікає ані в OpenAPI-спеку, ані в модель:
 *
 *   price numeric(12,2) -> price_cents integer
 *     У БД гроші — numeric: тип без втрати точності, без прив'язки до локалі
 *     (money) і без двійкового округлення (float). Назовні openapi.yaml
 *     обіцяє цілі копійки, тож множимо на 100 у запиті.
 *
 *   id bigint -> id string
 *     Ключ у БД — bigint GENERATED ALWAYS AS IDENTITY (не serial). У спеці id
 *     оголошений рядком, тож приводимо ::text.
 */
const PRODUCT_COLUMNS =
  'id::text AS id, name, (price * 100)::int AS price_cents, currency';

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
      // ORDER BY products.id, а не ORDER BY id: у SELECT є вихідна колонка з
      // тим самим іменем (id::text AS id), і бездомне `id` Postgres зіставив би
      // саме з нею — сортування поїхало б лексикографічно (1, 10, 100).
      `SELECT ${PRODUCT_COLUMNS} FROM products ORDER BY products.id LIMIT $1 OFFSET $2`,
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
    // id у спеці — рядок, у БД — bigint. Нечислові id відсікаємо тут, щоб не
    // отримати 500 від Postgres ("invalid input syntax for type bigint")
    // там, де за контрактом має бути 404.
    if (!/^[0-9]{1,18}$/.test(id)) return undefined;

    const { rows } = await this.db.query<Product>(
      `SELECT ${PRODUCT_COLUMNS} FROM products WHERE id = $1::bigint`,
      [id],
    );
    return rows[0];
  }
}
