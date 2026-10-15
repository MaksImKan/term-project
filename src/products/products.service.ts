import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env.schema';
import { encodeCursor, decodeCursor } from '../common/pagination';
import { DatabaseService } from '../db/database.service';
import { ListQuery, Page, Product } from '../models';
import { ProductRow, ProductsRepository } from '../repositories/products.repository';
import { Queryable } from '../repositories/types';

/**
 * Каталог живе у Postgres. Уся SQL винесена в ProductsRepository — сервіс
 * лишає собі лише те, що є його роботою: пагінацію з непрозорим курсором,
 * дефолти з конфіга і мапінг рядка БД у форму, яку обіцяє openapi.yaml.
 *
 * Завдяки цьому той самий репозиторій тестується у test/integration/ проти
 * справжнього Postgres (testcontainers), без підняття всього Nest.
 *
 * Єдине свідоме розходження зі спекою: id у БД — bigint, у спеці — рядок.
 * pg і так віддає bigint рядком, тож мапінг тут тривіальний.
 */
@Injectable()
export class ProductsService {
  private readonly products: ProductsRepository;

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService<Env, true>,
  ) {
    // DatabaseService — це обгортка над pg.Pool, тобто рівно той Queryable,
    // якого чекає репозиторій.
    this.products = new ProductsRepository(db as unknown as Queryable);
  }

  private toProduct(row: ProductRow): Product {
    return {
      id: String(row.id),
      name: row.name,
      price_cents: Number(row.price_cents),
      currency: row.currency,
    };
  }

  async list(query: ListQuery): Promise<Page<Product>> {
    const limit =
      query.limit === undefined
        ? this.config.get('DEFAULT_PAGE_LIMIT', { infer: true })
        : Number(query.limit);
    const offset = decodeCursor(query.cursor);

    // limit + 1 — щоб дізнатися, чи є наступна сторінка, без окремого COUNT.
    const rows = await this.products.listPage(limit + 1, offset);

    const hasMore = rows.length > limit;
    return {
      items: (hasMore ? rows.slice(0, limit) : rows).map((row) => this.toProduct(row)),
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

    const row = await this.products.findById(id);
    return row ? this.toProduct(row) : undefined;
  }
}
