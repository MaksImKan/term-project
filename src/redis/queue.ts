import { Queue, Worker, type JobsOptions } from 'bullmq';
import type Redis from 'ioredis';

/**
 * Черга BullMQ під роботу, якій немає місця в HTTP-запиті.
 *
 * Для цього домену це перерахунок рейтингу товару після замовлення: читання
 * агрегує відгуки й продажі, тримати це в циклі запиту означало б платити
 * сотнями мілісекунд на кожному POST.
 *
 * Три речі, які документація вимагає явно і які легко проґавити:
 *
 * 1. `attempts` + `backoff: { type: 'exponential', jitter }`. Без джитера всі
 *    впалі задачі ретраяться синхронно і б'ють по тому самому ресурсу, який
 *    щойно не витримав.
 * 2. `jobId` для дедуплікації — і НЕ `removeOnComplete: true` разом із ним:
 *    видалена задача більше не вважається дублікатом, тобто прибирання вимикає
 *    дедуп. Тримаємо `removeOnComplete: { age }` із запасом, більшим за вікно,
 *    у якому можливий повтор.
 * 3. `upsertJobScheduler`, а не `add({ repeat })`: repeat-API у BullMQ 6
 *    прибрано, а upsert (на відміну від add) не плодить дублікатів
 *    планувальника на кожному рестарті процесу.
 */
export const RATING_QUEUE = 'rating';

export interface RatingJobData {
  productId: string;
  /** Скільки перших спроб обробник має завалити — для demo:queue. */
  failTimes?: number;
}

/** Задачі живуть годину після успіху: дедуп по jobId лишається робочим. */
export const RETAIN_COMPLETED_SECONDS = 3600;

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 200,
    // Джитер розводить ретраї в часі: без нього три воркери підуть у базу
    // одночасно рівно тоді, коли вона щойно не впоралась.
    jitter: 0.5,
  },
  removeOnComplete: { age: RETAIN_COMPLETED_SECONDS },
  removeOnFail: { age: RETAIN_COMPLETED_SECONDS },
};

export function createQueue(connection: Redis): Queue<RatingJobData> {
  return new Queue<RatingJobData>(RATING_QUEUE, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
}

export interface WorkerHooks {
  /**
   * Викликається на КОЖНІЙ спробі. Другим аргументом іде сама задача, щоб
   * демо могло рахувати спроби саме падучої задачі, а не плюсувати до них
   * спрацювання планувальника.
   */
  onAttempt?: (attempt: number, job: { name: string; data: RatingJobData }) => void;
  onScheduledRun?: () => void;
}

/**
 * Воркер.
 *
 * Падіння моделюється прапорцем у data, а не станом процесу: так демо
 * лишається детермінованим і переживає перезапуск воркера — лічильник спроб
 * бере сам BullMQ (`job.attemptsMade`).
 */
export function createWorker(connection: Redis, hooks: WorkerHooks = {}): Worker<RatingJobData> {
  return new Worker<RatingJobData>(
    RATING_QUEUE,
    async (job) => {
      const attempt = job.attemptsMade + 1;
      hooks.onAttempt?.(attempt, { name: job.name, data: job.data });

      if (job.name === 'scheduled') {
        hooks.onScheduledRun?.();
        return { scheduled: true, at: new Date().toISOString() };
      }

      const failTimes = job.data.failTimes ?? 0;
      if (attempt <= failTimes) {
        throw new Error(`спроба ${attempt}: рейтинг ще не перерахувався`);
      }

      return { productId: job.data.productId, attempt };
    },
    {
      connection,
      concurrency: 2,
    },
  );
}
