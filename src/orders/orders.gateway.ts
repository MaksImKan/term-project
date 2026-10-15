import { Logger, OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { OrderEventsService, OrderStatusEvent } from './order-events.service';
import { OrdersService } from './orders.service';

/** Ім'я кімнати — єдине місце, де воно формується. */
export function orderRoom(orderId: string): string {
  return `orders:${orderId}`;
}

export interface JoinPayload {
  orderId?: string;
}

export interface JoinAck {
  ok: boolean;
  room?: string;
  /** anonymous | not_found | forbidden | bad_request */
  error?: string;
  lastEventId?: number;
}

/**
 * WebSocket-транспорт для потоку статусів.
 *
 * Gateway свідомо нічого не вирішує про домен: він лише (1) пускає або не пускає
 * сокет у кімнату і (2) перекладає події з шини в `server.to(room).emit`.
 * Сама подія народжується в OrdersService — транспорт про неї дізнається
 * підпискою, як і SSE-контролер.
 *
 * Авторизації в проєкті немає (`security: []` у спеці ДЗ-09), тому «користувач»
 * тут — це `auth.userId` із handshake. Для навчального завдання цього досить:
 * важливо, що перевірка власника ВІДБУВАЄТЬСЯ і що анонім із чужим отримують
 * відмову, а не те, яким саме механізмом підписаний токен.
 */
@WebSocketGateway({
  // Той самий HTTP-сервер і порт, що в REST: окремий порт тут нічого не дає,
  // а проксі й фаєрволи ускладнює.
  cors: { origin: '*' },
})
export class OrdersGateway implements OnModuleInit, OnGatewayConnection {
  private readonly logger = new Logger(OrdersGateway.name);

  @WebSocketServer()
  private server!: Server;

  constructor(
    private readonly orders: OrdersService,
    private readonly events: OrderEventsService,
  ) {}

  onModuleInit(): void {
    // Один підписник на весь gateway, а не на кожен сокет: сокети вже
    // «розкладені» по кімнатах, і socket.io сам доставить подію лише тим, хто
    // в потрібній кімнаті.
    this.events.stream.subscribe((event: OrderStatusEvent) => {
      this.server.to(orderRoom(event.order_id)).emit('order.status', event);
    });
  }

  handleConnection(client: Socket): void {
    // Підключення саме по собі нічого не дає: поки клієнт не зробив join і не
    // пройшов перевірку власника, він не в жодній кімнаті й подій не бачить.
    this.logger.debug(`socket ${client.id} connected (user=${userIdOf(client) ?? 'anonymous'})`);
  }

  @SubscribeMessage('join')
  async join(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: JoinPayload,
  ): Promise<JoinAck> {
    const orderId = payload?.orderId;
    if (!orderId) return { ok: false, error: 'bad_request' };

    const userId = userIdOf(client);
    // Анонім — відмова. Не «порожня кімната», а саме відмова: клієнт має
    // дізнатися, що він НЕ підписаний, інакше він мовчки чекатиме подій.
    if (!userId) return { ok: false, error: 'anonymous' };

    const order = this.orders.findOrNull(orderId);
    if (!order) return { ok: false, error: 'not_found' };
    if (order.buyer_id !== userId) {
      this.logger.warn(`socket ${client.id} (user=${userId}) -> чуже замовлення ${orderId}`);
      return { ok: false, error: 'forbidden' };
    }

    const room = orderRoom(orderId);
    await client.join(room);
    this.logger.log(`socket ${client.id} (user=${userId}) -> ${room}`);

    // lastEventId в ack — щоб клієнт, який щойно зайшов, знав, з якого місця
    // потоку він слухає, і міг добрати пропущене через SSE або /events.
    return { ok: true, room, lastEventId: this.events.lastEventId(orderId) };
  }
}

/**
 * Ідентичність клієнта: `auth` у handshake (socket.io передає його і при
 * реконекті), із запасним варіантом через query — зручно для `wscat` і curl-подібних
 * ручних перевірок.
 */
function userIdOf(client: Socket): string | null {
  const fromAuth = (client.handshake.auth as Record<string, unknown> | undefined)?.userId;
  if (typeof fromAuth === 'string' && fromAuth.length > 0) return fromAuth;

  const fromQuery = client.handshake.query?.userId;
  if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;

  return null;
}
