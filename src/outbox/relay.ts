import type { DataSource, EntityManager } from 'typeorm';
import { OrderPlacedEvent } from '../messaging/contracts';

/**
 * Relay — єдиний, хто виносить події з outbox назовні.
 *
 * Порядок кроків тут не стилістичний, а єдиний можливий:
 *
 *   SELECT … FOR UPDATE SKIP LOCKED   →   publish   →   UPDATE published_at
 *
 * Поміняти місцями publish і UPDATE не можна. Якщо спершу позначити рядок
 * винесеним, а потім публікувати, то відмова publish дасть «позначили, але не
 * віддали» — тобто ВТРАТУ події, і наступний прогін її вже не підбере.
 * У поточному порядку найгірше, що буває, — повторна публікація. Вибір тут не
 * між «добре» і «погано», а між дублем і втратою: дубль лікується
 * дедуплікацією на консюмері, втрата не лікується нічим.
 *
 * І ще одне, через що дедуп на консюмері обовʼязковий незалежно від
 * акуратності relay: помилка publish НЕ означає, що повідомлення не
 * доставлено. Загубитись могла відповідь брокера, а саме повідомлення вже
 * лежить у черзі. «Зловив помилку → відкотив → все чисто» — ілюзія.
 */

export interface RelayPublisher {
  publish(event: OrderPlacedEvent): Promise<void>;
}

export interface RelayStats {
  /** Скільки рядків узято в роботу. */
  picked: number;
  /** Скільки разів викликано publish (повтор рахується окремо). */
  published: number;
  /** Скільки рядків зрештою позначено винесеними. */
  marked: number;
  /** Скільки спроб завершилися помилкою публікації. */
  failed: number;
}

export interface RelayOptions {
  batchSize?: number;
  /**
   * Хук РІВНО між publish і UPDATE published_at — та сама точка, у якій
   * demo:crash-relay вбиває воркера. Кидок звідси лишає подію опублікованою,
   * але не позначеною: наступний прогін підбере її знову.
   */
  betweenPublishAndMark?: (row: OutboxBatchRow) => Promise<void> | void;
}

export interface OutboxBatchRow {
  id: string;
  type: string;
  payload: OrderPlacedEvent;
  attempts: number;
}

export const DEFAULT_BATCH_SIZE = 50;

/**
 * Один прохід relay: узяти пачку невинесених подій, опублікувати, позначити.
 *
 * Уся пачка йде в ОДНІЙ транзакції — не заради атомарності публікації (її тут
 * і не може бути), а заради локів: рядки лишаються заблокованими рівно доти,
 * доки воркер із ними працює.
 */
export async function relayOnce(
  dataSource: DataSource,
  publisher: RelayPublisher,
  options: RelayOptions = {},
): Promise<RelayStats> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const stats: RelayStats = { picked: 0, published: 0, marked: 0, failed: 0 };

  await dataSource.transaction(async (manager: EntityManager) => {
    // SKIP LOCKED, а не голий FOR UPDATE: без нього другий воркер не пропускає
    // зайняті рядки, а СТАЄ В ЧЕРГУ за ними. Дублів тоді теж нуль — ціною
    // нуля паралельності: воркери шикуються в шеренгу й чекають один одного.
    //
    // Умова — published_at IS NULL, а не курсор по id. Курсор тут пропускав би
    // рядки: bigserial видає номер на nextval, а видимим рядок стає лише на
    // COMMIT, тож транзакція з меншим id може закомітитись пізніше за сусідню
    // з більшим — і «усе, що більше за останній оброблений» її не побачить.
    const rows = (await manager.query(
      `SELECT id, type, payload, attempts
         FROM outbox
        WHERE published_at IS NULL
        ORDER BY created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT $1`,
      [batchSize],
    )) as OutboxBatchRow[];

    stats.picked = rows.length;

    for (const row of rows) {
      try {
        await publisher.publish(row.payload);
        stats.published += 1;
      } catch (error) {
        stats.failed += 1;
        // Лічильник спроб потрібен, щоб «вічно непублікована» подія була
        // видимою в метриках, а не тихо крутилась у кожному проході.
        await manager.query('UPDATE outbox SET attempts = attempts + 1 WHERE id = $1', [row.id]);
        console.error(
          `[relay] publish #${row.id} не вдався: ${error instanceof Error ? error.message : error}`,
        );
        continue;
      }

      await options.betweenPublishAndMark?.(row);

      await manager.query('UPDATE outbox SET published_at = now() WHERE id = $1', [row.id]);
      stats.marked += 1;
    }
  });

  return stats;
}

/**
 * Довгоживучий воркер: той самий прохід у циклі з паузою.
 *
 * Polling, а не LISTEN/NOTIFY: NOTIFY не переживає рестарт слухача, тож
 * пропущене сповіщення означало б непідібрану подію. Опитування таблиці
 * дешеве рівно завдяки частковому індексу WHERE published_at IS NULL —
 * він накриває тільки невинесений хвіст.
 */
export async function runRelay(
  dataSource: DataSource,
  publisher: RelayPublisher,
  options: RelayOptions & { intervalMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const interval = options.intervalMs ?? 200;

  while (!options.signal?.aborted) {
    const stats = await relayOnce(dataSource, publisher, options);
    if (stats.picked === 0) {
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
}
