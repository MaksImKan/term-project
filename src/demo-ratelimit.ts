import 'reflect-metadata';
import { connectQueue } from './redis/connections';
import { deleteByPrefix, report } from './redis/demo-support';
import { SlidingWindowLimiter, tooManyRequests } from './redis/rate-limit';

/**
 * demo:ratelimit — ліміт спільний для двох подів.
 *
 *   bash scripts/with-secrets.sh dev node dist/demo-ratelimit.js
 *
 * Два НЕЗАЛЕЖНІ екземпляри лімітера з власними зʼєднаннями — це модель двох
 * подів одного сервісу. Вони не знають один про одного і не мають спільної
 * памʼяті; спільне в них рівно одне — ключ у Redis.
 *
 * Саме це й ловиться: на лічильнику в памʼяті процесу два поди пропустили б
 * 2 × limit запитів, і status лишився б 200. Те саме стосується
 * @nestjs/throttler із його дефолтним сховищем — найчастіший спосіб здати цей
 * пункт «наполовину».
 *
 * Запити подаються по черзі між подами (round-robin), щоб жоден з них не
 * вичерпав ліміт самотужки.
 */
const CLIENT = 'demo-client';
const REQUESTS = 12;

async function main(): Promise<never> {
  const connections = [connectQueue(), connectQueue()];

  try {
    const pods = connections.map(
      (connection, index) => new SlidingWindowLimiter(connection, `pod-${index + 1}`),
    );
    const limit = pods[0].configuredLimit;

    await deleteByPrefix(connections[0], `ratelimit:${CLIENT}`);

    let allowed = 0;
    let blocked = 0;
    let lastStatus = 200;
    let lastRetryAfter = 0;

    for (let i = 0; i < REQUESTS; i += 1) {
      const pod = pods[i % pods.length];
      const decision = await pod.check(CLIENT);

      if (decision.allowed) {
        allowed += 1;
        lastStatus = 200;
        continue;
      }

      blocked += 1;
      const response = tooManyRequests(decision);
      lastStatus = response.status;
      lastRetryAfter = Number(response.headers['Retry-After']);
    }

    console.log(`[demo] подів: ${pods.length}, ліміт: ${limit} за вікно`);
    console.log(`[demo] пропущено ${allowed}, відкинуто ${blocked}`);
    console.log(`[demo] остання відповідь: ${lastStatus}, Retry-After: ${lastRetryAfter}`);

    await Promise.all(connections.map((connection) => connection.quit()));

    return report(
      {
        instances: pods.length,
        limit,
        requests: REQUESTS,
        allowed,
        blocked,
        status: lastStatus,
        'retry-after': lastRetryAfter >= 1 ? 1 : 0,
      },
      [
        { what: 'подів щонайменше два', ok: pods.length >= 2 },
        {
          what: `сумарно пропущено рівно ${limit} — ліміт спільний, а не на кожен под`,
          ok: allowed === limit,
        },
        { what: 'зайві запити відкинуто', ok: blocked >= 1 },
        { what: 'відкинутий запит дав 429', ok: lastStatus === 429 },
        { what: 'заголовок Retry-After виставлено', ok: lastRetryAfter >= 1 },
      ],
    );
  } catch (error) {
    await Promise.all(connections.map((connection) => connection.quit().catch(() => undefined)));
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
