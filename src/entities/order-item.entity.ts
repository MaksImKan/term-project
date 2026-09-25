import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Order } from './order.entity';
import { Product } from './product.entity';

/**
 * order_items — ЯВНА join-entity, а не @ManyToMany.
 *
 * Звʼязок «замовлення ↔ товар» справді M:N, але на самому звʼязку висять дані:
 * кількість і ціна на момент купівлі. @ManyToMany створив би службову таблицю
 * з двох колонок, у яку ці поля нікуди покласти, і сховав би її від коду.
 * Правило просте: є дані на звʼязку — є окрема сутність.
 *
 * unit_price_cents — копія, а не посилання на products.price_cents: ціна в
 * каталозі змінюється, а те, за скільки покупець купив, змінюватись не може.
 */
@Entity({ name: 'order_items' })
@Unique('order_items_one_row_per_product', ['orderId', 'productId'])
@Check('order_items_quantity_positive', 'quantity > 0')
@Check('order_items_price_positive', 'unit_price_cents > 0')
export class OrderItem {
  @PrimaryGeneratedColumn('identity', {
    type: 'bigint',
    generatedIdentity: 'BY DEFAULT',
  })
  id!: string;

  @Column({ type: 'bigint', name: 'order_id' })
  orderId!: string;

  /**
   * onDelete: 'CASCADE' — позиція не існує без свого замовлення. Це єдиний
   * звʼязок у схемі, де дитина справді належить батькові: видаляємо
   * замовлення — його рядки йдуть слідом, і осиротілих позицій не лишається.
   */
  @ManyToOne(() => Order, (order) => order.items, {
    onDelete: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'order_id' })
  order!: Order;

  @Column({ type: 'bigint', name: 'product_id' })
  productId!: string;

  /**
   * onDelete: 'RESTRICT' — протилежний випадок: товар НЕ володіє позицією.
   * Видалити товар, який колись купували, не можна: інакше з історії зникне
   * рядок, на якому тримається сума замовлення.
   */
  @ManyToOne(() => Product, (product) => product.orderItems, {
    onDelete: 'RESTRICT',
    nullable: false,
  })
  @JoinColumn({ name: 'product_id' })
  product!: Product;

  @Column({ type: 'integer' })
  quantity!: number;

  /** Ціна одиниці на момент купівлі, цілі копійки. */
  @Column({ type: 'integer', name: 'unit_price_cents' })
  unitPriceCents!: number;
}
