import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { OrderItem } from './order-item.entity';
import { User } from './user.entity';

export const ORDER_STATUSES = [
  'pending',
  'paid',
  'shipped',
  'delivered',
  'cancelled',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * orders — головна таблиця обсягу (у db/seed.sql її наливає 200 000 рядків).
 *
 * Два індекси нижче — ті самі, що в db/indexes.sql з ДЗ-12. @Index не вміє
 * описати напрям сортування колонки, а обидва реально створені як
 * `created_at DESC`: без цього `ORDER BY created_at DESC LIMIT n` дав би
 * `Index Scan Backward` замість `Index Scan`. Тому справжній DDL дописано в
 * міграції руками, а декоратори лишаються документацією наміру.
 * Перевірено: diff TypeORM напрям сортування не порівнює, тож повторний
 * `migration:generate` фантомної різниці на цих двох індексах не дає.
 * Детальніше — README, розділ «Чого ORM не вміє».
 */
@Entity({ name: 'orders' })
@Index('idx_orders_buyer_created_at', ['buyerId', 'createdAt'])
@Index('idx_orders_pending_created_at', ['createdAt'], {
  where: `status = 'pending'`,
})
@Check('orders_status_known', `status IN ('pending','paid','shipped','delivered','cancelled')`)
@Check('orders_currency_iso', `currency ~ '^[A-Z]{3}$'`)
@Check('orders_total_natural', 'total_cents >= 0')
@Check('orders_paid_at_sane', 'paid_at IS NULL OR paid_at >= created_at')
// Оплачене/відправлене/доставлене замовлення зобовʼязане мати час оплати.
// Скасоване могло бути оплаченим до скасування, тож для нього paid_at вільний.
@Check(
  'orders_paid_has_paid_at',
  `status IN ('pending','cancelled') OR paid_at IS NOT NULL`,
)
export class Order {
  @PrimaryGeneratedColumn('identity', {
    type: 'bigint',
    generatedIdentity: 'BY DEFAULT',
  })
  id!: string;

  @Column({ type: 'bigint', name: 'buyer_id' })
  buyerId!: string;

  /**
   * onDelete: 'RESTRICT' — покупця з замовленнями видалити не можна: замовлення
   * це фінансовий документ, він переживає обліковий запис.
   */
  @ManyToOne(() => User, (user) => user.orders, {
    onDelete: 'RESTRICT',
    nullable: false,
  })
  @JoinColumn({ name: 'buyer_id' })
  buyer!: User;

  @Column({ type: 'text', default: 'pending' })
  status!: OrderStatus;

  /** Сума замовлення в цілих копійках; дорівнює сумі позицій. */
  @Column({ type: 'integer', name: 'total_cents', default: 0 })
  totalCents!: number;

  @Column({ type: 'text', default: 'UAH' })
  currency!: string;

  // Звичайна колонка з DEFAULT now(), а не @CreateDateColumn: той завжди
  // перезаписує значення поточним часом, а детермінованому seed потрібні
  // фіксовані дати (у orders від них ще й залежить CHECK на paid_at).
  @Column({ type: 'timestamptz', name: 'created_at', default: () => 'now()' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'paid_at', nullable: true })
  paidAt!: Date | null;

  /**
   * Позиції замовлення. cascade: true дозволяє зберегти замовлення разом із
   * позиціями одним save(); саме видалення каскадить БД — див. OrderItem.order.
   */
  @OneToMany(() => OrderItem, (item) => item.order, { cascade: ['insert'] })
  items!: OrderItem[];
}
