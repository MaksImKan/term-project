import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { OrderItem } from './order-item.entity';
import { User } from './user.entity';

/**
 * products — каталог. Таблиця, по якій іде повнотекстовий пошук (ДЗ-12, q4).
 *
 * Гроші — `price_cents integer`, цілі копійки. Не float (двійкове округлення),
 * не money (тягне локаль), не numeric-рядок у JS. Усі операції домену —
 * додавання й множення на кількість, тож ціле число точне за побудовою.
 */
@Entity({ name: 'products' })
@Check('products_name_filled', 'length(btrim(name)) > 0')
@Check('products_price_positive', 'price_cents > 0')
@Check('products_currency_iso', `currency ~ '^[A-Z]{3}$'`)
@Check('products_stock_natural', 'stock >= 0')
export class Product {
  @PrimaryGeneratedColumn('identity', {
    type: 'bigint',
    generatedIdentity: 'BY DEFAULT',
  })
  id!: string;

  @Column({ type: 'bigint', name: 'seller_id' })
  sellerId!: string;

  /**
   * onDelete: 'RESTRICT' — продавця з товарами видалити не можна. Каталог і
   * позиції замовлень посилаються на ці рядки; мовчазне зникнення товару
   * зіпсувало б історію покупок.
   */
  @ManyToOne(() => User, (user) => user.products, {
    onDelete: 'RESTRICT',
    nullable: false,
  })
  @JoinColumn({ name: 'seller_id' })
  seller!: User;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  description!: string;

  /** Ціна в цілих копійках. 129900 = 1299.00 грн. */
  @Column({ type: 'integer', name: 'price_cents' })
  priceCents!: number;

  @Column({ type: 'text', default: 'UAH' })
  currency!: string;

  @Column({ type: 'integer', default: 0 })
  stock!: number;

  @Column({ type: 'boolean', name: 'is_published', default: true })
  isPublished!: boolean;

  // Звичайна колонка з DEFAULT now(), а не @CreateDateColumn: той завжди
  // перезаписує значення поточним часом, а детермінованому seed потрібні
  // фіксовані дати (у orders від них ще й залежить CHECK на paid_at).
  @Column({ type: 'timestamptz', name: 'created_at', default: () => 'now()' })
  createdAt!: Date;

  /**
   * Пошуковий вектор — ГЕНЕРОВАНА збережена колонка: Postgres перераховує її
   * сам на кожному INSERT/UPDATE name або description.
   *
   * insert/update: false — писати в неї не можна за визначенням;
   * select: false — 280 байт на рядок не потрібні жодному API-ендпоінту.
   *
   * GIN-індекс по цій колонці TypeORM описати не вміє (@Index не знає про
   * USING GIN), тому він живе у міграції написаним руками — див.
   * src/migrations/*-InitialSchema.ts.
   * Наслідок, про який треба знати: повторний `migration:generate` пропонує
   * `DROP INDEX idx_products_search_vector` і створити його заново як b-tree.
   * Цю правку не приймаємо — README, розділ «Чого ORM не вміє».
   */
  @Column({
    type: 'tsvector',
    name: 'search_vector',
    asExpression: `to_tsvector('simple', name || ' ' || description)`,
    generatedType: 'STORED',
    insert: false,
    update: false,
    select: false,
    nullable: true,
  })
  searchVector?: string;

  /**
   * Позиції замовлень, у яких фігурує цей товар.
   * Каскаду тут немає навмисно — див. OrderItem.product.
   */
  @OneToMany(() => OrderItem, (item) => item.product)
  orderItems!: OrderItem[];
}
