import { Queryable } from './types';

export interface OrderRow extends Record<string, unknown> {
  id: string;
  buyer_id: string;
  status: string;
  total_cents: number;
  currency: string;
}

export interface OrderItemRow extends Record<string, unknown> {
  id: string;
  order_id: string;
  product_id: string;
  quantity: number;
  unit_price_cents: number;
}

export interface OrderWithItems extends OrderRow {
  items: Array<{
    product_id: string;
    product_name: string;
    quantity: number;
    unit_price_cents: number;
  }>;
}

export interface SellerRevenueRow extends Record<string, unknown> {
  seller_id: string;
  seller_name: string;
  orders_count: string;
  units_sold: string;
  revenue_cents: string;
}

/**
 * Доступ до замовлень. Тут три речі, яких мок не має в принципі:
 * JOIN із агрегацією позицій, звіт з GROUP BY і констрейнти
 * (UNIQUE (order_id, product_id), FK на покупця, CHECK на кількість).
 */
export class OrdersRepository {
  constructor(private readonly db: Queryable) {}

  async create(buyerId: string, status = 'pending'): Promise<OrderRow> {
    const paidAt = status === 'pending' || status === 'cancelled' ? null : new Date();
    const { rows } = await this.db.query<OrderRow>(
      `INSERT INTO orders (buyer_id, status, total_cents, currency, paid_at)
       VALUES ($1, $2, 0, 'UAH', $3)
       RETURNING id, buyer_id, status, total_cents, currency`,
      [buyerId, status, paidAt],
    );
    return rows[0];
  }

  async addItem(
    orderId: string,
    productId: string,
    quantity: number,
    unitPriceCents: number,
  ): Promise<OrderItemRow> {
    const { rows } = await this.db.query<OrderItemRow>(
      `INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents)
       VALUES ($1, $2, $3, $4)
       RETURNING id, order_id, product_id, quantity, unit_price_cents`,
      [orderId, productId, quantity, unitPriceCents],
    );
    return rows[0];
  }

  /** Перераховує суму замовлення з його позицій — одним висловом, у БД. */
  async recalculateTotal(orderId: string): Promise<number> {
    const { rows } = await this.db.query<{ total_cents: number }>(
      `UPDATE orders o
          SET total_cents = coalesce(t.total, 0)
         FROM (SELECT sum(quantity * unit_price_cents) AS total
                 FROM order_items WHERE order_id = $1) AS t
        WHERE o.id = $1
        RETURNING o.total_cents`,
      [orderId],
    );
    return rows[0]?.total_cents ?? 0;
  }

  /**
   * Замовлення разом із позиціями — один запит із JOIN і json-агрегацією.
   * Саме та поведінка, яку мок підміняє «масивом у памʼяті» й тим самим
   * перестає перевіряти найцікавіше: що звʼязок справді склеюється в БД.
   */
  async findWithItems(orderId: string): Promise<OrderWithItems | null> {
    const { rows } = await this.db.query<OrderWithItems>(
      `SELECT o.id, o.buyer_id, o.status, o.total_cents, o.currency,
              coalesce(
                json_agg(
                  json_build_object(
                    'product_id', oi.product_id::text,
                    'product_name', p.name,
                    'quantity', oi.quantity,
                    'unit_price_cents', oi.unit_price_cents
                  ) ORDER BY oi.id
                ) FILTER (WHERE oi.id IS NOT NULL),
                '[]'::json
              ) AS items
         FROM orders o
         LEFT JOIN order_items oi ON oi.order_id = o.id
         LEFT JOIN products p ON p.id = oi.product_id
        WHERE o.id = $1
        GROUP BY o.id, o.buyer_id, o.status, o.total_cents, o.currency`,
      [orderId],
    );
    return rows[0] ?? null;
  }

  /**
   * Звіт «виторг по продавцях»: три JOIN-и, SUM, COUNT(DISTINCT …) і GROUP BY.
   * Через find() це не виражається — і через мок теж.
   */
  async revenueBySeller(statuses = ['paid', 'shipped', 'delivered']): Promise<SellerRevenueRow[]> {
    const { rows } = await this.db.query<SellerRevenueRow>(
      `SELECT s.id::text                               AS seller_id,
              s.full_name                              AS seller_name,
              count(DISTINCT o.id)::text               AS orders_count,
              sum(oi.quantity)::text                   AS units_sold,
              sum(oi.quantity * oi.unit_price_cents)::text AS revenue_cents
         FROM order_items oi
         JOIN orders o   ON o.id = oi.order_id
         JOIN products p ON p.id = oi.product_id
         JOIN users s    ON s.id = p.seller_id
        WHERE o.status = ANY($1::text[])
        GROUP BY s.id, s.full_name
        ORDER BY sum(oi.quantity * oi.unit_price_cents) DESC, s.id`,
      [statuses],
    );
    return rows;
  }

  async countByStatus(status: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      'SELECT count(*) AS count FROM orders WHERE status = $1',
      [status],
    );
    return Number(rows[0].count);
  }
}
