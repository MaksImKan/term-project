/**
 * Контракт події `order.placed` (ДЗ-19).
 *
 * Це свідомо спроектована форма, а не ORM-сутність через spread. Сутність —
 * це внутрішня модель, яка змінюється разом зі схемою БД; подія — публічний
 * інтерфейс, за який тримаються чужі сервіси. Якщо в `orders` зʼявиться
 * колонка, споживач не має про це дізнатись.
 *
 * `eventId` СТАБІЛЬНИЙ: він виводиться з факту («замовлення N оформлено»), а
 * не з моменту публікації. Якби тут був свіжий uuid на кожну спробу, повторна
 * публікація після обриву створила б подію, яку споживач не впізнав би як
 * дубль, — і вся ідемпотентність нижче по ланцюжку перестала б працювати.
 */
export const ORDER_PLACED = 'order.placed';

export interface OrderPlacedEvent {
  /** Стабільний ідентифікатор факту. За ним споживач упізнає дубль. */
  eventId: string;
  /** Тип події — те, за чим споживач вирішує, чи вміє він це обробляти. */
  type: typeof ORDER_PLACED;
  /** Коли факт стався, ISO-8601. */
  occurredAt: string;
  /** Версія контракту: без неї міграція споживачів перетворюється на ворожіння. */
  version: 1;
  data: {
    orderId: string;
    buyerId: string;
    productId: string;
    quantity: number;
    totalCents: number;
    currency: string;
  };
}

export function buildOrderPlacedEvent(data: OrderPlacedEvent['data']): OrderPlacedEvent {
  return {
    // Один факт — один id. Повторна публікація того самого замовлення дасть
    // рівно той самий eventId.
    eventId: `evt_order_placed_${data.orderId}`,
    type: ORDER_PLACED,
    occurredAt: new Date().toISOString(),
    version: 1,
    data,
  };
}

/**
 * Валідація на вході споживача.
 *
 * Повідомлення, яке не проходить її, НЕ стане валідним від повтору — це
 * отруєне повідомлення, і його місце в DLQ, а не в нескінченному циклі.
 */
export function parseOrderPlaced(raw: unknown): OrderPlacedEvent {
  const event = raw as Partial<OrderPlacedEvent>;

  if (!event || typeof event !== 'object') throw new Error('подія не є обʼєктом');
  if (typeof event.eventId !== 'string' || event.eventId.length === 0) {
    throw new Error('немає eventId — нічим упізнати дубль');
  }
  if (event.type !== ORDER_PLACED) {
    throw new Error(`невідомий type: ${String(event.type)}`);
  }
  if (event.version !== 1) {
    throw new Error(`непідтримувана версія контракту: ${String(event.version)}`);
  }

  const data = event.data as Partial<OrderPlacedEvent['data']> | undefined;
  if (!data || typeof data.orderId !== 'string') throw new Error('немає data.orderId');
  if (typeof data.quantity !== 'number' || !Number.isInteger(data.quantity) || data.quantity <= 0) {
    throw new Error(`некоректний data.quantity: ${String(data?.quantity)}`);
  }

  return event as OrderPlacedEvent;
}
