import 'reflect-metadata';
import { EntityManager } from 'typeorm';
import type { DemoOutcome } from './demo-support';
import { assertSeeded, finish, openDataSource, sleep } from './demo-support';
import { Task } from './entities';

/**
 * Воркер-пул над outbox-чергою: кілька воркерів розбирають задачі паралельно,
 * і кожна задача обробляється РІВНО ОДИН раз.
 *
 *   npm run demo:workers
 *
 * Механіка — `SELECT … FOR UPDATE SKIP LOCKED LIMIT 1`:
 *   * FOR UPDATE   — воркер бере рядковий лок на задачу, яку взяв;
 *   * SKIP LOCKED  — решта воркерів не стають у чергу за цим локом, а просто
 *                    проходять далі й беруть наступну вільну задачу.
 *
 * Без SKIP LOCKED пул виродився б у послідовну обробку: другий воркер стояв би
 * на локі першого. Без FOR UPDATE двоє взяли б ту саму задачу, і покупець
 * отримав би два листи — саме це і ловить лічильник `processed`.
 *
 * Транзакція тримається відкритою на весь час обробки: якщо воркер упаде до
 * COMMIT, лок зникне разом із його зʼєднанням, статус лишиться `pending`, і
 * задачу підбере інший. Результат і `status = 'done'` комітяться разом.
 */

const TASK_COUNT = 20;
const WORKERS = 4;
/** Скільки «працює» одна задача. Достатньо, щоб паралельність було видно. */
const WORK_MS = 120;
/** Порожній результат SKIP LOCKED означає «вільних немає ЗАРАЗ», не «черга порожня». */
const IDLE_RETRIES = 3;
const IDLE_DELAY_MS = 40;

type ClaimMode = 'sql' | 'orm';

interface Claimed {
  id: string;
  type: string;
}

/**
 * Сирий SQL — так це виглядає у будь-якій мові й будь-якому драйвері.
 */
async function claimWithSql(manager: EntityManager): Promise<Claimed | null> {
  const rows = (await manager.query(
    `SELECT id, type
       FROM tasks
      WHERE status = 'pending'
      ORDER BY id
      FOR UPDATE SKIP LOCKED
      LIMIT 1`,
  )) as Claimed[];
  return rows[0] ?? null;
}

/**
 * Те саме через QueryBuilder: setLock('pessimistic_write') це FOR UPDATE,
 * setOnLocked('skip_locked') це SKIP LOCKED. Обидва воркери в одному пулі
 * можуть користуватись різними формами — для Postgres це один і той самий запит.
 */
async function claimWithOrm(manager: EntityManager): Promise<Claimed | null> {
  const task = await manager
    .getRepository(Task)
    .createQueryBuilder('t')
    .select(['t.id', 't.type'])
    .where('t.status = :status', { status: 'pending' })
    .orderBy('t.id', 'ASC')
    .limit(1)
    .setLock('pessimistic_write')
    .setOnLocked('skip_locked')
    .getOne();

  return task ? { id: task.id, type: task.type } : null;
}

interface WorkerStats {
  name: string;
  mode: ClaimMode;
  done: number;
  idleRounds: number;
}

async function runWorker(
  ds: Awaited<ReturnType<typeof openDataSource>>,
  name: string,
  mode: ClaimMode,
): Promise<WorkerStats> {
  const stats: WorkerStats = { name, mode, done: 0, idleRounds: 0 };
  let idleInARow = 0;

  while (idleInARow < IDLE_RETRIES) {
    const claimed = await ds.transaction(async (manager) => {
      const task = mode === 'sql' ? await claimWithSql(manager) : await claimWithOrm(manager);
      if (!task) return null;

      // «Робота»: лист, чек, виклик платіжки. Лок на рядку тримається весь час.
      await sleep(WORK_MS);

      await manager.query(
        `UPDATE tasks
            SET status     = 'done',
                processed  = processed + 1,
                attempts   = attempts + 1,
                locked_by  = $2,
                result     = $3,
                updated_at = now()
          WHERE id = $1`,
        [task.id, name, `оброблено воркером ${name}`],
      );

      return task;
    });

    if (claimed) {
      stats.done += 1;
      idleInARow = 0;
    } else {
      stats.idleRounds += 1;
      idleInARow += 1;
      await sleep(IDLE_DELAY_MS);
    }
  }

  return stats;
}

async function main(): Promise<DemoOutcome> {
  const ds = await openDataSource(WORKERS + 2);

  try {
    await assertSeeded(ds);

    // Своя черга з нуля, щоб числа були передбачувані.
    await ds.query('DELETE FROM tasks');
    await ds.query(
      `INSERT INTO tasks (type, payload)
       SELECT 'order.receipt', jsonb_build_object('n', n)
         FROM generate_series(1, $1) AS g(n)`,
      [TASK_COUNT],
    );

    console.log('── demo:workers ──');
    console.log(`задач у черзі: ${TASK_COUNT}, воркерів: ${WORKERS}, «робота» однієї: ${WORK_MS} мс`);
    console.log('вибірка: SELECT … FOR UPDATE SKIP LOCKED LIMIT 1\n');

    const startedAt = Date.now();
    const stats = await Promise.all(
      Array.from({ length: WORKERS }, (_, i) =>
        // Перший воркер бере задачі через QueryBuilder, решта — сирим SQL:
        // для Postgres це той самий запит, і вони чесно конкурують між собою.
        runWorker(ds, `worker-${i + 1}`, i === 0 ? 'orm' : 'sql'),
      ),
    );
    const elapsedMs = Date.now() - startedAt;

    const [{ done, twice, pending, max_processed }] = await ds.query<
      Array<{ done: string; twice: string; pending: string; max_processed: string }>
    >(`SELECT count(*) FILTER (WHERE status = 'done')    AS done,
              count(*) FILTER (WHERE processed > 1)      AS twice,
              count(*) FILTER (WHERE status = 'pending') AS pending,
              coalesce(max(processed), 0)                AS max_processed
         FROM tasks`);

    console.table(
      stats.map((s) => ({
        воркер: s.name,
        'спосіб вибірки': s.mode === 'orm' ? "QueryBuilder setOnLocked('skip_locked')" : 'сирий SQL SKIP LOCKED',
        'задач оброблено': s.done,
        'холостих обертів': s.idleRounds,
      })),
    );

    const sequentialMs = TASK_COUNT * WORK_MS;
    console.log(`оброблено двічі: ${Number(twice)}`);
    console.log(`задач у статусі done: ${done} з ${TASK_COUNT}, лишилось pending: ${pending}`);
    console.log(`максимум processed на одній задачі: ${max_processed}`);
    console.log(
      `час: ${elapsedMs} мс проти ${sequentialMs} мс послідовно ` +
        `(${(sequentialMs / elapsedMs).toFixed(1)}× швидше, воркерів ${WORKERS})`,
    );

    const usedWorkers = stats.filter((s) => s.done > 0).length;
    const problems: string[] = [];
    if (Number(twice) !== 0) problems.push(`${twice} задач оброблено двічі — SKIP LOCKED не тримає`);
    if (Number(done) !== TASK_COUNT) problems.push(`done ${done}, а задач ${TASK_COUNT}`);
    if (Number(pending) !== 0) problems.push(`лишилось ${pending} необроблених`);
    if (usedWorkers < 2) problems.push(`працював лише ${usedWorkers} воркер — розподілу немає`);
    if (elapsedMs >= sequentialMs) {
      problems.push(`${elapsedMs} мс не менше за послідовні ${sequentialMs} мс`);
    }

    if (problems.length > 0) {
      for (const problem of problems) console.error(`  ✖ ${problem}`);
      return { ok: false, summary: 'воркер-пул нечесний' };
    }

    return {
      ok: true,
      summary:
        `${TASK_COUNT} задач розібрано ${usedWorkers} воркерами за ${elapsedMs} мс ` +
        `(послідовно було б ${sequentialMs} мс), оброблено двічі: 0`,
    };
  } finally {
    await ds.destroy().catch(() => undefined);
  }
}

main()
  .then(finish)
  .catch((error: unknown) => {
    console.error('\n✖ demo:workers не відпрацював.\n');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
