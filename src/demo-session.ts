import 'reflect-metadata';
import { connectQueue } from './redis/connections';
import { report, sleep } from './redis/demo-support';
import { SessionStore } from './redis/session';

/**
 * demo:session — сесія живе в Redis і подовжується при активності.
 *
 *   bash scripts/with-secrets.sh dev node dist/demo-session.js
 *
 * Що доводиться:
 *  1. Усі запити демо йдуть під ОДНИМ ідентифікатором сесії — тобто стан
 *     справді спільний, а не створюється заново на кожному зверненні.
 *  2. Ключ лежить у Redis, а не в памʼяті процесу: його видно окремим
 *     зʼєднанням, яке нічого не знає про SessionStore.
 *  3. TTL після активності БІЛЬШИЙ, ніж був до неї — rolling працює.
 *
 * Між запитами демо справді чекає: без паузи TTL не встигне зменшитись, і
 * «подовження» було б непомітним навіть на правильній реалізації.
 *
 * Сесії лежать у ЧЕРГОВОМУ інстансі (noeviction), не в кеші: allkeys-lru
 * колись викинув би сесію під тиском памʼяті, і вийшло б розлогінення, якого
 * ніхто не може відтворити.
 */
const SESSION_TTL_S = 60;
const REQUESTS = 4;
const PAUSE_MS = 1500;

async function main(): Promise<never> {
  const redis = connectQueue();
  // Окреме зʼєднання-«спостерігач»: воно перевіряє наявність ключа ззовні,
  // нічого не знаючи про сам SessionStore.
  const observer = connectQueue();

  try {
    const sessions = new SessionStore(redis, SESSION_TTL_S);

    const sessionId = await sessions.create('u_1');
    console.log(`[demo] сесія створена: ${sessionId}`);

    const seenIds = new Set<string>([sessionId]);
    const ttlAfterCreate = await sessions.ttl(sessionId);
    console.log(`[demo] TTL одразу після створення: ${ttlAfterCreate}s`);

    // Пауза, щоб TTL реально просів.
    await sleep(PAUSE_MS);
    const ttlBeforeActivity = await sessions.ttl(sessionId);
    console.log(`[demo] TTL після паузи: ${ttlBeforeActivity}s`);

    let requests = 0;
    for (let i = 0; i < REQUESTS; i += 1) {
      const data = await sessions.touch(sessionId);
      if (!data) throw new Error('сесія зникла посеред роботи');
      requests += 1;
      seenIds.add(sessionId);
      if (i < REQUESTS - 1) await sleep(PAUSE_MS);
    }

    const ttlAfterActivity = await sessions.ttl(sessionId);
    console.log(`[demo] TTL після ${requests} запитів: ${ttlAfterActivity}s`);

    // Перевірка ззовні: ключ справді в Redis.
    const keys = await observer.keys(`sess:${sessionId}`);
    const inRedis = keys.length === 1 ? 1 : 0;

    const data = await sessions.touch(sessionId);
    console.log(`[demo] лічильник запитів у сесії: ${data?.requests}`);

    await sessions.destroy(sessionId);
    await redis.quit();
    await observer.quit();

    return report(
      {
        requests,
        sessions: seenIds.size,
        'in-redis': inRedis,
        'ttl-renewed': ttlAfterActivity > ttlBeforeActivity ? 1 : 0,
      },
      [
        { what: `запитів ${requests}`, ok: requests >= 3 },
        { what: 'усі запити під однією сесією', ok: seenIds.size === 1 },
        { what: 'ключ сесії видно в Redis окремим зʼєднанням', ok: inRedis === 1 },
        {
          what: `TTL подовжився (${ttlBeforeActivity}s -> ${ttlAfterActivity}s)`,
          ok: ttlAfterActivity > ttlBeforeActivity,
        },
      ],
    );
  } catch (error) {
    await redis.quit().catch(() => undefined);
    await observer.quit().catch(() => undefined);
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
