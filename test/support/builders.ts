import { randomBytes } from 'node:crypto';
import { Queryable } from '../../src/repositories/types';

/**
 * Test data builders.
 *
 * Сенс не в економії рядків, а в тому, що тест говорить ЛИШЕ про те, що для
 * нього важливо. `aProduct({ priceCents: 100 })` читається як «товар, у якого
 * важлива ціна»; решта полів валідні й унікальні, і їх не треба ані вигадувати,
 * ані тримати в голові. Унікальність обовʼязкова: email у users під UNIQUE, і
 * «стіна фікстур» із захардкодженим test@example.com розсипається на другому ж
 * тесті в тому самому файлі.
 */

let sequence = 0;

/** Короткий унікальний суфікс: монотонний лічильник + випадковість. */
export function uniqueSuffix(): string {
  sequence += 1;
  return `${sequence.toString(36)}${randomBytes(3).toString('hex')}`;
}

export interface UserAttrs {
  email: string;
  fullName: string;
  city: string;
  isActive: boolean;
  balanceCents: number;
}

export function aUser(overrides: Partial<UserAttrs> = {}): UserAttrs {
  const suffix = uniqueSuffix();
  return {
    email: `buyer-${suffix}@example.com`,
    fullName: `Покупець ${suffix}`,
    city: 'Київ',
    isActive: true,
    balanceCents: 1_000_000_00,
    ...overrides,
  };
}

export interface ProductAttrs {
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  stock: number;
  isPublished: boolean;
}

export function aProduct(overrides: Partial<ProductAttrs> = {}): ProductAttrs {
  const suffix = uniqueSuffix();
  return {
    name: `Шкіряні кросівки ${suffix}`,
    description: `Оригінальні шкіряні кросівки, артикул ${suffix}.`,
    priceCents: 249_900,
    currency: 'UAH',
    stock: 10,
    isPublished: true,
    ...overrides,
  };
}

export interface OrderAttrs {
  status: 'pending' | 'paid' | 'shipped' | 'delivered' | 'cancelled';
}

export function anOrder(overrides: Partial<OrderAttrs> = {}): OrderAttrs {
  return { status: 'pending', ...overrides };
}

// ── Хелпери вставки: тест не пише SQL руками ────────────────────────────────

export async function insertUser(db: Queryable, attrs: UserAttrs = aUser()): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, full_name, city, is_active, balance_cents)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [attrs.email, attrs.fullName, attrs.city, attrs.isActive, attrs.balanceCents],
  );
  return rows[0].id;
}

export async function insertProduct(
  db: Queryable,
  sellerId: string,
  attrs: ProductAttrs = aProduct(),
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO products (seller_id, name, description, price_cents, currency, stock, is_published)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      sellerId,
      attrs.name,
      attrs.description,
      attrs.priceCents,
      attrs.currency,
      attrs.stock,
      attrs.isPublished,
    ],
  );
  return rows[0].id;
}
