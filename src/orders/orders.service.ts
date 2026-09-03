import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { CreateOrderBody, ListQuery, Order, Page } from '../models';
import { paginate } from '../common/pagination';
import { ProductsService } from '../products/products.service';

interface IdempotencyRecord {
  hash: string;
  snapshot: Order;
}

@Injectable()
export class OrdersService {
  constructor(private readonly products: ProductsService) {}

  private readonly orders: Order[] = [
    {
      id: 'o_1',
      status: 'created',
      items: [{ product_id: 'p_1', quantity: 1 }],
      total_cents: 2600,
      currency: 'UAH',
      created_at: '2026-08-01T09:00:00.000Z',
    },
    {
      id: 'o_2',
      status: 'paid',
      items: [{ product_id: 'p_2', quantity: 2 }],
      total_cents: 1800,
      currency: 'UAH',
      created_at: '2026-08-02T12:30:00.000Z',
    },
  ];

  private seq = this.orders.length;
  private readonly idempotency = new Map<string, IdempotencyRecord>();

  list(query: ListQuery): Page<Order> {
    return paginate(this.orders, query);
  }

  findOne(id: string): Order {
    const order = this.orders.find((o) => o.id === id);
    if (!order) throw new NotFoundException(`order not found: ${id}`);
    return order;
  }

  // Повертає замовлення + прапорець replay (для заголовка Idempotency-Replay).
  create(key: string, body: CreateOrderBody): { order: Order; replay: boolean } {
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');

    const seen = this.idempotency.get(key);
    if (seen) {
      // той самий ключ + те саме тіло -> та сама відповідь
      if (seen.hash === hash) return { order: seen.snapshot, replay: true };
      // той самий ключ + інше тіло -> конфлікт
      throw new UnprocessableEntityException(
        'Idempotency-Key was already used with a different request body',
      );
    }

    let total = 0;
    for (const item of body.items) {
      const product = this.products.findRaw(item.product_id);
      if (!product) throw new NotFoundException(`product not found: ${item.product_id}`);
      total += product.price_cents * item.quantity;
    }

    const order: Order = {
      id: `o_${++this.seq}`,
      status: 'created',
      items: body.items.map((i) => ({ product_id: i.product_id, quantity: i.quantity })),
      total_cents: total,
      currency: body.currency ?? 'UAH',
      created_at: new Date().toISOString(),
    };

    this.orders.push(order);
    this.idempotency.set(key, { hash, snapshot: order });
    return { order, replay: false };
  }
}
