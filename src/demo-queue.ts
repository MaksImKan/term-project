import 'reflect-metadata';
import { connectQueue, evictionPolicy } from './redis/connections';
import { report, sleep, waitFor } from './redis/demo-support';
import { RATING_QUEUE, createQueue, createWorker } from './redis/queue';
import { PRODUCTS } from './seed';

/**
 * demo:queue — черга ретраїть, дедуплікує і має планувальник.
 *
 *   bash scripts/with-secrets.sh dev node dist/demo-queue.js
 *
 * Чотири твердження:
 *
 *  1. Інстанс черги має noeviction — пряма вимога документації BullMQ
 *     («cannot work properly if Redis evicts keys arbitrarily»). Якби черга
 *     стояла на кеш-інстансі, BullMQ сам написав би в лог «IMPORTANT!
 *     Eviction policy is allkeys-lru».
 *  2. Падуча задача виконується щонайменше тричі й зрештою завершується —
 *     attempts + exponential backoff із джитером.
 *  3. Два `add` з тим самим `jobId` дають ОДНУ задачу в черзі. Саме тому тут
 *     немає `removeOnComplete: true`: видалена задача більше не вважається
 *     дублікатом, тобто прибирання вимикає дедуп.
 *  4. Планувальник створений через `upsertJobScheduler` (repeat-API у BullMQ 6
 *     прибрано) і спрацьовує повторно. Upsert, а не add: інакше кожен рестарт
 *     плодив би дублікати планувальників.
 */
const PRODUCT_ID = PRODUCTS[0].id!;
const FAIL_TIMES = 2; // дві перші спроби падають -> третя успішна
const SCHEDULER_ID = 'rating-nightly';
const SCHEDULER_EVERY_MS = 700;
const OBSERVE_MS = 4_000;

async function main(): Promise<never> {
  const connection = connectQueue();
  const workerConnection = connectQueue();

  const queue = createQueue(connection);
  let attempts = 0;
  let scheduledRuns = 0;
  let completed = 0;

  const worker = createWorker(workerConnection, {
    onAttempt: (attempt, job) => {
      // Рахуємо спроби САМЕ падучої задачі: спрацювання планувальника — це
      // інше число, і змішувати їх означало б показати 10 замість 3.
      if (job.data.failTimes === undefined) return;
      attempts += 1;
      console.log(`[queue] спроба ${attempt}`);
    },
    onScheduledRun: () => {
      scheduledRuns += 1;
    },
  });
  // Успішне завершення рахуємо лише для падучої задачі — її id відомий.
  let retryJobId: string | undefined;
  worker.on('completed', (job) => {
    if (job.id === retryJobId) completed += 1;
  });

  try {
    const policy = await evictionPolicy(connection);
    console.log(`[demo] інстанс черги: maxmemory-policy=${policy}`);

    // Чистий аркуш: і задачі, і планувальники попередніх прогонів.
    await queue.obliterate({ force: true }).catch(() => undefined);
    for (const scheduler of await queue.getJobSchedulers()) {
      if (scheduler.key) await queue.removeJobScheduler(scheduler.key).catch(() => undefined);
    }

    // ── Ретраї ──────────────────────────────────────────────────────────────
    const retryJob = await queue.add('rating', {
      productId: PRODUCT_ID,
      failTimes: FAIL_TIMES,
    });
    retryJobId = retryJob.id;
    await waitFor(() => completed >= 1, 20_000);

    // ── Дедуплікація по jobId ───────────────────────────────────────────────
    // Воркер цю задачу розбере, тому рахуємо глибину черги ДО того, як він
    // устигне: пауза воркера на час перевірки — чесніше, ніж вгадувати тайминг.
    await worker.pause();

    const jobId = `rating:${PRODUCT_ID}:2026-10-29`;
    let added = 0;
    for (let i = 0; i < 2; i += 1) {
      await queue.add('rating', { productId: PRODUCT_ID }, { jobId });
      added += 1;
    }
    const queued = await queue.getWaitingCount();
    console.log(`[demo] після ${added} add з jobId=${jobId}: у черзі ${queued}`);

    // Задача дедупу своє вже показала — прибираємо її, щоб вона не додавала
    // шуму в лічильники нижче. Саме ця задача й демонструє, чому тут немає
    // removeOnComplete: true — видалена задача перестає бути дублікатом.
    await queue.remove(jobId).catch(() => undefined);
    await worker.resume();

    // ── Планувальник ────────────────────────────────────────────────────────
    await queue.upsertJobScheduler(
      SCHEDULER_ID,
      { every: SCHEDULER_EVERY_MS },
      { name: 'scheduled', data: { productId: PRODUCT_ID } },
    );
    // Повторний upsert — саме те, що відбувається на рестарті процесу.
    // Планувальник має лишитись один.
    await queue.upsertJobScheduler(
      SCHEDULER_ID,
      { every: SCHEDULER_EVERY_MS },
      { name: 'scheduled', data: { productId: PRODUCT_ID } },
    );

    const schedulers = (await queue.getJobSchedulers()).length;
    console.log(`[demo] планувальників після двох upsert: ${schedulers}`);

    await sleep(OBSERVE_MS);
    console.log(`[demo] спрацювань планувальника за ${OBSERVE_MS} мс: ${scheduledRuns}`);

    for (const scheduler of await queue.getJobSchedulers()) {
      if (scheduler.key) await queue.removeJobScheduler(scheduler.key).catch(() => undefined);
    }

    await worker.close();
    await queue.close();
    await connection.quit();
    await workerConnection.quit();

    return report(
      {
        'queue-noeviction': policy === 'noeviction' ? 1 : 0,
        attempts,
        completed,
        added,
        queued,
        schedulers,
        'scheduled-runs': scheduledRuns,
      },
      [
        { what: 'інстанс черги з noeviction', ok: policy === 'noeviction' },
        { what: `падуча задача виконалась ${attempts} разів`, ok: attempts >= FAIL_TIMES + 1 },
        { what: 'і зрештою завершилась успішно', ok: completed === 1 },
        { what: 'два add з тим самим jobId дали одну задачу', ok: added === 2 && queued === 1 },
        { what: 'планувальник один після двох upsert', ok: schedulers === 1 },
        { what: 'планувальник спрацював щонайменше двічі', ok: scheduledRuns >= 2 },
      ],
    );
  } catch (error) {
    await worker.close().catch(() => undefined);
    await queue.close().catch(() => undefined);
    await connection.quit().catch(() => undefined);
    await workerConnection.quit().catch(() => undefined);
    throw error;
  }
}

void RATING_QUEUE;

main().catch((error: unknown) => {
  console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
