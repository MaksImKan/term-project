// Спільні типи. Форма — рівно як у openapi/openapi.yaml
// (валідатор відповіді перевіряє це в рантаймі).

export interface Product {
  id: string;
  name: string;
  price_cents: number; // цілі копійки, без float
  currency: string;
}

export interface OrderItem {
  product_id: string;
  quantity: number;
}

export type OrderStatus = 'created' | 'paid' | 'cancelled';

export interface Order {
  id: string;
  // Власник замовлення. Авторизації в проєкті немає свідомо (security: [] у
  // спеці), але WS-кімната мусить комусь належати — інакше немає що перевіряти
  // в join. Див. src/orders/orders.gateway.ts.
  buyer_id: string;
  status: OrderStatus;
  items: OrderItem[];
  total_cents: number; // цілі копійки
  currency: string;
  created_at: string;
}

export interface UpdateOrderStatusBody {
  status: OrderStatus;
}

export interface CreateOrderBody {
  items: OrderItem[];
  currency?: string;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export interface ListQuery {
  limit?: string | number;
  cursor?: string;
}
