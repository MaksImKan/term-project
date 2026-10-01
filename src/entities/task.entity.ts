import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Order } from './order.entity';

export const TASK_STATUSES = ['pending', 'done', 'failed'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * tasks — черга post-processing (лист покупцю, чек, оновлення аналітики).
 *
 * Черга живе в тій самій БД, а не в брокері, навмисно: задача створюється в
 * ТІЙ САМІЙ транзакції, що й замовлення. Або є і замовлення, і задача, або
 * немає нічого. З брокером довелося б або публікувати до COMMIT (і отримати
 * лист про замовлення, якого не існує), або після (і втратити лист, якщо
 * процес упав між COMMIT і publish) — це класична проблема, яку розв'язує
 * саме outbox-таблиця.
 *
 * Розбирають чергу воркери запитом `FOR UPDATE SKIP LOCKED`: узяту задачу
 * бачить лише той воркер, що її заблокував, решта просто проходять далі.
 */
@Entity({ name: 'tasks' })
// Partial-індекс під єдиний гарячий запит воркера:
//   WHERE status = 'pending' ORDER BY id LIMIT 1
// У черзі, де оброблені задачі лишаються назавжди, повний індекс по status
// розпухав би разом з історією, а цей накриває тільки живий хвіст.
@Index('idx_tasks_pending', ['id'], { where: `status = 'pending'` })
@Check('tasks_status_known', `status IN ('pending','done','failed')`)
@Check('tasks_attempts_natural', 'attempts >= 0')
@Check('tasks_processed_natural', 'processed >= 0')
export class Task {
  @PrimaryGeneratedColumn('identity', {
    type: 'bigint',
    generatedIdentity: 'BY DEFAULT',
  })
  id!: string;

  /** Тип задачі: 'order.receipt', 'order.notify', … */
  @Column({ type: 'text' })
  type!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ type: 'text', default: 'pending' })
  status!: TaskStatus;

  /** Скільки разів воркер брався за задачу (включно з невдачами). */
  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  /**
   * Скільки разів задачу ДОВЕЛИ до кінця. Саме цей лічильник доводить, що
   * SKIP LOCKED працює: будь-яке значення > 1 означає, що два воркери
   * обробили ту саму задачу, тобто покупець отримав два листи.
   */
  @Column({ type: 'integer', default: 0 })
  processed!: number;

  /** Який воркер обробив задачу — для розподілу у звіті demo:workers. */
  @Column({ type: 'text', name: 'locked_by', nullable: true })
  lockedBy!: string | null;

  @Column({ type: 'text', nullable: true })
  result!: string | null;

  @Column({ type: 'bigint', name: 'order_id', nullable: true })
  orderId!: string | null;

  /**
   * onDelete: 'CASCADE' — задача не має сенсу без свого замовлення. Це той
   * самий випадок, що order_items: дитина належить батькові.
   */
  @ManyToOne(() => Order, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'order_id' })
  order!: Order | null;

  @Column({ type: 'timestamptz', name: 'created_at', default: () => 'now()' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'updated_at', default: () => 'now()' })
  updatedAt!: Date;
}
