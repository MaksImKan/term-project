import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import {
  CreateOrderBody,
  ListQuery,
  Order,
  OrderStatus,
  Page,
  UpdateOrderStatusBody,
} from '../models';
import { OrderEventsService, OrderStatusEvent } from './order-events.service';
import { paginate } from '../common/pagination';
import { ProductsService } from '../products/products.service';
import { Env } from '../config/env.schema';

interface IdempotencyRecord {
  hash: string;
  snapshot: Order;
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly products: ProductsService,
    private readonly config: ConfigService<Env, true>,
    private readonly events: OrderEventsService,
  ) {}

  private readonly orders: Order[] = [
    {
      id: 'o_1',
      buyer_id: 'u_1',
      status: 'created',
      items: [{ product_id: 'p_1', quantity: 1 }],
      total_cents: 2600,
      currency: 'UAH',
      created_at: '2026-08-01T09:00:00.000Z',
    },
    {
      id: 'o_2',
      buyer_id: 'u_1',
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
    return paginate(this.orders, query, this.config.get('DEFAULT_PAGE_LIMIT', { infer: true }));
  }

  findOne(id: string): Order {
    const order = this.findOrNull(id);
    if (!order) throw new NotFoundException(`order not found: ${id}`);
    return order;
  }

  /** Без винятку — для тих, хто сам вирішує, що робити з «немає». */
  findOrNull(id: string): Order | null {
    return this.orders.find((o) => o.id === id) ?? null;
  }

  /**
   * Зміна статусу — і єдине місце, звідки народжується подія order.status.
   *
   * Емісія стоїть саме тут, а не в контролері: контролер знає про HTTP, а не
   * про те, що зміна статусу комусь цікава. Завдяки цьому той самий виклик із
   * будь-якого іншого місця (воркер, сідер, CLI) теж засвітиться в потоці, а
   * обидва транспорти — WS і SSE — отримають подію з однієї шини.
   *
   * Подія публікується на КОЖЕН застосований запит, навіть якщо статус той
   * самий: подія означає «статус застосовано», і previous_status робить
   * «нічого не змінилося» видимим споживачу. Інакше повторний PATCH тихо
   * зникав би з потоку, і клієнт не мав би як відрізнити «не дійшло» від
   * «дійшло, але було те саме».
   */
  updateStatus(id: string, body: UpdateOrderStatusBody): { order: Order; event: OrderStatusEvent } {
    const order = this.findOne(id);
    const previous: OrderStatus = order.status;

    order.status = body.status;

    const event = this.events.publish({
      order_id: order.id,
      status: order.status,
      previous_status: previous,
    });

    return { order, event };
  }

  // Повертає замовлення + прапорець replay (для заголовка Idempotency-Replay).
  async create(
    key: string,
    body: CreateOrderBody,
    buyerId: string,
  ): Promise<{ order: Order; replay: boolean }> {
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
      // ціна береться з Postgres (ProductsService), а не з памʼяті процесу
      const product = await this.products.findRaw(item.product_id);
      if (!product) throw new NotFoundException(`product not found: ${item.product_id}`);
      total += product.price_cents * item.quantity;
    }

    const order: Order = {
      id: `o_${++this.seq}`,
      buyer_id: buyerId,
      status: 'created',
      items: body.items.map((i) => ({ product_id: i.product_id, quantity: i.quantity })),
      total_cents: total,
      currency: body.currency ?? this.config.get('DEFAULT_CURRENCY', { infer: true }),
      created_at: new Date().toISOString(),
    };

    this.orders.push(order);
    this.idempotency.set(key, { hash, snapshot: order });
    return { order, replay: false };
  }
}
