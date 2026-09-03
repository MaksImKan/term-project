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

export interface Order {
  id: string;
  status: 'created' | 'paid' | 'cancelled';
  items: OrderItem[];
  total_cents: number; // цілі копійки
  currency: string;
  created_at: string;
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
