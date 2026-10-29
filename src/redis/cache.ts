import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { envSchema } from '../config/env.schema';

/**
 * Cache-aside з джитером TTL і захистом від stampede.
 *
 * Промах → база → запис у кеш; влучання → тільки Redis. TTL ставиться ЗАВЖДИ,
 * навіть якщо є явна інвалідація на записі: інвалідація — це додатково, а не
 * замість. Ключ без TTL, який інвалідація колись проґавила, лишається в кеші
 * назавжди.
 *
 * ── Про джитер ──────────────────────────────────────────────────────────────
 * TTL = base + random(0..jitter). Без джитера ключі, прогріті одним циклом,
 * протухають в одну секунду — і дають stampede на рівному місці, у хвилину,
 * коли ніхто нічого не змінював.
 *
 * ── Про лок ─────────────────────────────────────────────────────────────────
 * На холодному ключі N одночасних читань мали б дати N походів у базу. Тут
 * перший бере `SET lock:<key> <token> NX PX`, іде в базу і наповнює кеш;
 * решта чекає й перечитує кеш. Це ОПТИМІЗАЦІЯ: якщо лок зламається, ми просто
 * сходимо в базу двічі. Саме тому тут вистачає compare-and-delete і не
 * потрібен fencing token — детальніше в README.
 */

export interface CacheOptions {
  ttlSeconds?: number;
  jitterSeconds?: number;
  /** Скільки чекати на чужий лок, перш ніж піти в базу самому. */
  lockWaitMs?: number;
  /** Скільки живе сам лок. Має перекривати найдовше очікуване читання. */
  lockTtlMs?: number;
}

const LOCK_POLL_MS = 20;

/**
 * Зняти лок ТІЛЬКИ свій.
 *
 * Голий DEL знімає чужий: між «мій лок протух» і «я його знімаю» вміщається
 * чужий SET NX, і ти прибереш лок, який уже належить іншому.
 *
 * `DELEX … IFEQ <token>` зʼявився аж у Redis 8.4, а стенд тут на 7.x, тож
 * беремо Lua — вона працює на будь-якій версії і виконується атомарно.
 */
const UNLOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

export class CacheAside {
  constructor(
    private readonly redis: Redis,
    private readonly options: CacheOptions = {},
  ) {}

  /** TTL із джитером. Повертає секунди. */
  ttlWithJitter(): number {
    const base = this.options.ttlSeconds ?? envSchema.shape.CACHE_TTL_S.parse(process.env.CACHE_TTL_S);
    const jitter =
      this.options.jitterSeconds ??
      envSchema.shape.CACHE_TTL_JITTER_S.parse(process.env.CACHE_TTL_JITTER_S);
    return base + Math.floor(Math.random() * (jitter + 1));
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  async set<T>(key: string, value: T): Promise<number> {
    const ttl = this.ttlWithJitter();
    // Запис у кеш не має права покласти запит користувача: Redis на стоковому
    // конфізі (maxmemory 0 + noeviction) кидає OOM саме тут.
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttl);
    } catch (error) {
      console.error(
        `[cache] не вдалося записати ${key}: ${error instanceof Error ? error.message : error}`,
      );
    }
    return ttl;
  }

  /**
   * Прочитати через кеш. `load` викликається щонайбільше одним конкурентом.
   */
  async read<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = await this.get<T>(key);
    if (hit !== null) return hit;

    const lockKey = `lock:${key}`;
    const token = randomUUID();
    const lockTtl = this.options.lockTtlMs ?? 5_000;
    const waitMs = this.options.lockWaitMs ?? 3_000;

    const acquired = await this.redis.set(lockKey, token, 'PX', lockTtl, 'NX');

    if (acquired !== 'OK') {
      // Лок у когось іншого: чекаємо, поки він наповнить кеш.
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        await sleep(LOCK_POLL_MS);
        const value = await this.get<T>(key);
        if (value !== null) return value;
      }
      // Чекали й не дочекались — краще зайвий похід у базу, ніж таймаут
      // користувачеві. Це те саме «лок зламався = платимо кількома центами».
      return load();
    }

    try {
      // Перечитуємо під локом: поки ми його брали, хтось міг устигнути.
      const second = await this.get<T>(key);
      if (second !== null) return second;

      const value = await load();
      await this.set(key, value);
      return value;
    } finally {
      await this.redis.eval(UNLOCK_SCRIPT, 1, lockKey, token).catch(() => undefined);
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
