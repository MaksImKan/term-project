import { Injectable, NotFoundException } from '@nestjs/common';
import { ListQuery, Page, Product } from '../models';
import { paginate } from '../common/pagination';

@Injectable()
export class ProductsService {
  private readonly products: Product[] = [
    { id: 'p_1', name: 'Mechanical Keyboard', price_cents: 2600, currency: 'UAH' },
    { id: 'p_2', name: 'Wireless Mouse', price_cents: 900, currency: 'UAH' },
    { id: 'p_3', name: 'USB-C Hub', price_cents: 1500, currency: 'UAH' },
  ];

  list(query: ListQuery): Page<Product> {
    return paginate(this.products, query);
  }

  findOne(id: string): Product {
    const product = this.products.find((p) => p.id === id);
    if (!product) throw new NotFoundException(`product not found: ${id}`);
    return product;
  }

  // Для розрахунку суми замовлення.
  findRaw(id: string): Product | undefined {
    return this.products.find((p) => p.id === id);
  }
}
