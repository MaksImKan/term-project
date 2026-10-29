import type Redis from 'ioredis';
import { envSchema } from '../config/env.schema';

/**
 * Rate-limit: ковзне вікно на ZSET, одним Lua-скриптом.
 *
 * ── Чому ковзне вікно ───────────────────────────────────────────────────────
 * Питання тут завжди одне: дозволяємо сплеск чи ні? Фіксоване вікно сплеск
 * дозволяє — і не трохи: 5 запитів о 12:00:59 і ще 5 о 12:01:00 це 10 запитів
 * за 320 мілісекунд при ліміті 5. Це не баг реалізації, це властивість моделі.
 * Для захисту від зловживання публічним API така діра неприйнятна: саме в неї
 * і цілять. Token bucket дозволяє сплеск свідомо й контрольовано — він
 * правильний там, де сплеск ЗАКОНОМІРНИЙ (пакетна синхронізація клієнта).
 * Тут ми обмежуємо чужих, а не своїх, тож беремо ковзне вікно: рівно N за
 * будь-які останні W секунд, без винятків на межі.
 *
 * ── Чому один скрипт, а не три команди ──────────────────────────────────────
 * Між `ZCARD` і `ZADD` встигає влізти інший под, і ліміт протікає рівно там,
 * де він найпотрібніший — під навантаженням. Тут атомарність є вимогою
 * КОРЕКТНОСТІ, на відміну від лока в кеші, де вона була оптимізацією.
 *
 * ── Чому лічильник у Redis ──────────────────────────────────────────────────
 * У памʼяті процесу ліміт множиться на кількість подів, і жоден локальний
 * тест цього не побачить, бо локально под один. Те саме стосується
 * @nestjs/throttler із його дефолтним сховищем.
 */
const SLIDING_WINDOW = `
local key      = KEYS[1]
local now      = tonumber(ARGV[1])
local window   = tonumber(ARGV[2])
local limit    = tonumber(ARGV[3])
local member   = ARGV[4]

-- Викидаємо все, що вже поза вікном.
redis.call("ZREMRANGEBYSCORE", key, 0, now - window)

local used = redis.call("ZCARD", key)
if used >= limit then
  local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
  local resetMs = window - (now - tonumber(oldest[2]))
  return {0, used, resetMs}
end

redis.call("ZADD", key, now, member)
-- TTL трохи довший за вікно: ключ прибереться сам, якщо клієнт зник.
redis.call("PEXPIRE", key, window + 1000)
return {1, used + 1, 0}`;

export interface RateLimitDecision {
  allowed: boolean;
  /** Скільки запитів уже враховано у вікні. */
  used: number;
  /** Скільки секунд чекати до звільнення слота. Завжди ≥ 1 для Retry-After. */
  retryAfterSeconds: number;
}

export class SlidingWindowLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private sequence = 0;

  constructor(
    private readonly redis: Redis,
    /** Імʼя екземпляра — щоб у демо було видно, що подів справді два. */
    private readonly instanceId = 'pod-1',
    options: { limit?: number; windowSeconds?: number } = {},
  ) {
    this.limit =
      options.limit ?? envSchema.shape.RATE_LIMIT_MAX.parse(process.env.RATE_LIMIT_MAX);
    this.windowMs =
      1000 *
      (options.windowSeconds ??
        envSchema.shape.RATE_LIMIT_WINDOW_S.parse(process.env.RATE_LIMIT_WINDOW_S));
  }

  get configuredLimit(): number {
    return this.limit;
  }

  async check(clientId: string): Promise<RateLimitDecision> {
    // Член ZSET має бути унікальним, інакше повторний ZADD із тим самим
    // значенням лише оновить score, і запит не порахується.
    const member = `${this.instanceId}:${Date.now()}:${this.sequence++}`;

    const [allowed, used, resetMs] = (await this.redis.eval(
      SLIDING_WINDOW,
      1,
      `ratelimit:${clientId}`,
      Date.now(),
      this.windowMs,
      this.limit,
      member,
    )) as [number, number, number];

    return {
      allowed: allowed === 1,
      used,
      // Retry-After у секундах і не менше одиниці: «0» означало б «пробуй
      // просто зараз», а слот ще не звільнився.
      retryAfterSeconds: Math.max(1, Math.ceil(resetMs / 1000)),
    };
  }
}

/** Відповідь, яку віддає HTTP-край при перевищенні. */
export interface LimitedResponse {
  status: number;
  headers: Record<string, string>;
}

export function tooManyRequests(decision: RateLimitDecision): LimitedResponse {
  return {
    status: 429,
    headers: { 'Retry-After': String(decision.retryAfterSeconds) },
  };
}
