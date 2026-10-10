import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { OrdersService } from './orders.service';
import { OrderEventsService, OrderStatusEvent } from './order-events.service';
import { CreateOrderBody, UpdateOrderStatusBody } from '../models';

/** Темп реконекту, який сервер пропонує клієнтові (мс). */
const SSE_RETRY_MS = 1000;
/** Період порожнього коментаря, щоб проксі не рвали «тихий» потік. */
const SSE_HEARTBEAT_MS = 15_000;

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly events: OrderEventsService,
  ) {}

  @Get()
  list(@Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.orders.list({ limit, cursor });
  }

  /**
   * SSE-потік статусів одного замовлення.
   *
   * Оголошений ДО `@Get(':orderId')` — не тому, що інакше не працює (параметр
   * маршруту не захоплює слеш), а щоб обидва GET-и читалися поруч.
   *
   * Пишемо в `res` руками, а не через `@Sse()`: потрібен контроль над першим
   * рядком `retry:`, над heartbeat-коментарями і над тим, щоб жоден
   * `res.json()` не викликався — саме його перехоплює валідатор відповідей зі
   * спеки, а потік тут не JSON-документ.
   *
   * Перевірки власника тут свідомо НЕМАЄ: потік читається анонімно. У проді на
   * нього вішається той самий guard, що й на WS-join, — див. README.
   */
  @Get(':orderId/events')
  stream(
    @Param('orderId') orderId: string,
    @Res() res: Response,
    @Headers('last-event-id') lastEventIdHeader?: string,
    @Query('lastEventId') lastEventIdQuery?: string,
  ): void {
    // Неіснуюче замовлення має дати 404 problem+json, а не порожній потік:
    // кидаємо ДО writeHead, поки відповіддю ще володіє фільтр винятків.
    this.orders.findOne(orderId);

    res.writeHead(200, {
      // Без charset: SSE за специфікацією завжди UTF-8, а зайвий суфікс лише
      // ускладнює грепи на кшталт `grep -i '^content-type'`.
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // nginx інакше буферизує відповідь і «притримує» події до кінця потоку.
      'X-Accel-Buffering': 'no',
    });

    // Перший рядок — темп реконекту. Без нього браузер бере свій дефолт у
    // кілька секунд, і потік виглядає як «висить».
    res.write(`retry: ${SSE_RETRY_MS}\n\n`);

    // Last-Event-ID: заголовок ставить сам клієнт при реконекті; query-параметр
    // лишений для ручної перевірки інструментами, яким незручно слати заголовки.
    const lastEventId = parseEventId(lastEventIdHeader ?? lastEventIdQuery);
    for (const missed of this.events.replaySince(orderId, lastEventId)) {
      res.write(formatEvent(missed));
    }

    const subscription = this.events.stream.subscribe((event) => {
      if (event.order_id !== orderId) return;
      res.write(formatEvent(event));
    });

    const heartbeat = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS);

    // Без цього кожен відключений клієнт лишав би по підписці й по таймеру —
    // класичний витік на довгоживучих зʼєднаннях.
    res.on('close', () => {
      clearInterval(heartbeat);
      subscription.unsubscribe();
      res.end();
    });
  }

  @Get(':orderId')
  getById(@Param('orderId') orderId: string) {
    return this.orders.findOne(orderId);
  }

  @Post()
  @HttpCode(201)
  async create(
    // Наявність заголовка вже гарантував валідатор (required у спеці).
    // Node віддає імена заголовків у lowercase, тож 'idempotency-key'.
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() body: CreateOrderBody,
    @Res({ passthrough: true }) res: Response,
    @Headers('x-user-id') userId?: string,
  ) {
    const { order, replay } = await this.orders.create(idempotencyKey, body, userId || 'u_1');
    if (replay) res.setHeader('Idempotency-Replay', 'true');
    return order; // Nest -> res.json(order) -> валідатор перевірить відповідь
  }

  /**
   * Зміна статусу. Контролер лише розбирає HTTP — подію в шину кладе
   * OrdersService, і вже звідти її розбирають обидва транспорти.
   */
  @Patch(':orderId/status')
  updateStatus(@Param('orderId') orderId: string, @Body() body: UpdateOrderStatusBody) {
    return this.orders.updateStatus(orderId, body).order;
  }
}

/** `id: N\nevent: …\ndata: …\n\n` — рівно той формат, що читає EventSource. */
function formatEvent(event: OrderStatusEvent): string {
  return `id: ${event.id}\nevent: order.status\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Сміття в Last-Event-ID — це «почни з початку буфера», а не 500. */
function parseEventId(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
