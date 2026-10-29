import Redis from 'ioredis';
import { envSchema } from '../config/env.schema';

/**
 * Два зʼєднання, бо два інстанси, бо дві несумісні вимоги до одного процесу.
 *
 * Кеш хоче `maxmemory` + `allkeys-lru`: без них стоковий Redis не деградує
 * повільно, а в якийсь момент починає кидати «OOM command not allowed when
 * used memory > maxmemory» на ЗАПИС — і разом із кешем падає запит
 * користувача.
 *
 * Черга хоче рівно протилежного: документація BullMQ каже, що черга «cannot
 * work properly if Redis evicts keys arbitrarily», і вимагає `noeviction`.
 *
 * `maxmemory-policy` — налаштування ПРОЦЕСУ, не бази всередині нього, тож
 * `SELECT 1` ці дві вимоги не розводить. Звідси два контейнери.
 */

export interface RedisUrls {
  cache: string;
  queue: string;
}

export function redisUrls(): RedisUrls {
  return {
    cache: envSchema.shape.REDIS_URL.parse(process.env.REDIS_URL),
    queue: envSchema.shape.REDIS_QUEUE_URL.parse(process.env.REDIS_QUEUE_URL),
  };
}

export function connectCache(url = redisUrls().cache): Redis {
  // Для кеша падати швидко — правильно: кеш недоступний, значить читаємо базу,
  // а не висимо на реконекті всередині HTTP-запиту.
  return new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false });
}

/**
 * Зʼєднання під чергу й сесії.
 *
 * `maxRetriesPerRequest: null` — вимога BullMQ до зʼєднань воркера: інакше
 * ioredis при розриві кине виняток, і воркер зламається замість того, щоб
 * дочекатись Redis.
 */
export function connectQueue(url = redisUrls().queue): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false });
}

/** Політика витіснення інстанса — читається в рантаймі, а не з конфіга. */
export async function evictionPolicy(client: Redis): Promise<string> {
  const [, value] = (await client.config('GET', 'maxmemory-policy')) as [string, string];
  return value;
}

/** Ліміт памʼяті інстанса в байтах. 0 означає «без ліміту». */
export async function maxMemoryBytes(client: Redis): Promise<number> {
  const [, value] = (await client.config('GET', 'maxmemory')) as [string, string];
  return Number(value);
}
