import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Order } from './order.entity';

/**
 * picking_tasks — ефект споживача події `order.placed` (ДЗ-19).
 *
 * Одна подія — один рядок складського завдання «зібрати замовлення».
 *
 * `event_id` тут не службове поле «на всяк випадок», а ПРИРОДНИЙ КЛЮЧ ефекту:
 * саме завдяки UNIQUE на ньому повторна доставка тієї самої події не подвоює
 * роботу. Вставка робиться як `INSERT … ON CONFLICT (event_id) DO NOTHING`,
 * тож дубль не кидає помилку — він просто не створює другого рядка, і
 * споживач бачить це по rowCount.
 *
 * Чому саме так, а не лічильник на кшталт `UPDATE … SET qty = qty - 1`:
 * ідемпотентність — властивість ОПЕРАЦІЇ, і операція «вставити рядок із цим
 * ключем» нею володіє, а «відняти одиницю» — ні. Сховище при цьому те саме,
 * де живуть решта даних, тож гарантія переживає рестарт споживача й існує між
 * двома репліками — на відміну від Set у памʼяті процесу.
 */
@Entity({ name: 'picking_tasks' })
@Index('uq_picking_tasks_event_id', ['eventId'], { unique: true })
export class PickingTask {
  @PrimaryGeneratedColumn('identity', {
    type: 'bigint',
    generatedIdentity: 'BY DEFAULT',
  })
  id!: string;

  /** Ідентифікатор події, що спричинила це завдання. Стабільний між повторами. */
  @Column({ type: 'text' })
  eventId!: string;

  @Column({ type: 'bigint', name: 'order_id' })
  orderId!: string;

  @ManyToOne(() => Order, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'order_id' })
  order!: Order;

  @Column({ type: 'integer' })
  quantity!: number;

  @Column({ type: 'timestamptz', name: 'created_at', default: () => 'now()' })
  createdAt!: Date;
}
