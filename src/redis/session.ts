import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

/**
 * Токен-стан (сесія) у Redis із rolling TTL.
 *
 * Два рішення, які варто назвати:
 *
 * 1. Сховище — Redis, а не памʼять процесу. Після рестарту процесу сесія має
 *    жити; між двома подами вона має бути однією й тією ж.
 * 2. Інстанс — ЧЕРГОВИЙ, не кеш. У кеш-інстансі стоїть allkeys-lru, і він
 *    колись викине сесію під тиском памʼяті. Отримаємо розлогінення, яке
 *    неможливо відтворити: ключ зник не тому, що протух, а тому, що був
 *    найменш популярним у вибірці з пʼяти. Третю коробку не підіймаємо — у
 *    сесій і черги однакова вимога «нічого не викидати самочинно».
 *
 * Rolling TTL: сесія читається на кожному запиті й на кожному ж продовжується.
 * Без цього активного користувача викине посеред роботи рівно через TTL від
 * логіну — незалежно від того, що він увесь цей час щось робив.
 *
 * Зберігаємо хешем, а не рядком: окремі поля (lastSeenAt, requests) оновлюються
 * без перечитування й перезапису всього обʼєкта.
 */

export interface SessionData extends Record<string, string> {
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  requests: string;
}

export class SessionStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds = 60,
    private readonly prefix = 'sess:',
  ) {}

  private key(id: string): string {
    return `${this.prefix}${id}`;
  }

  async create(userId: string): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.redis
      .multi()
      .hset(this.key(id), { userId, createdAt: now, lastSeenAt: now, requests: '0' })
      .expire(this.key(id), this.ttlSeconds)
      .exec();
    return id;
  }

  /**
   * Прочитати сесію й ПРОДОВЖИТИ її TTL — одним походом у Redis.
   *
   * `GETEX`-подібна семантика для хеша: `HGETALL` + `EXPIRE` у транзакції.
   * Окреме поле можна було б подовжити через `HGETEX`, але тут продовжується
   * вся сесія: активність у будь-якому полі означає, що користувач живий.
   */
  async touch(id: string): Promise<SessionData | null> {
    const results = await this.redis
      .multi()
      .hgetall(this.key(id))
      .hincrby(this.key(id), 'requests', 1)
      .hset(this.key(id), 'lastSeenAt', new Date().toISOString())
      .expire(this.key(id), this.ttlSeconds)
      .exec();

    const data = results?.[0]?.[1] as Record<string, string> | undefined;
    if (!data || Object.keys(data).length === 0) return null;
    return data as SessionData;
  }

  /** Скільки секунд лишилось жити сесії. -2 = ключа немає, -1 = без TTL. */
  async ttl(id: string): Promise<number> {
    return this.redis.ttl(this.key(id));
  }

  async exists(id: string): Promise<boolean> {
    return (await this.redis.exists(this.key(id))) === 1;
  }

  async destroy(id: string): Promise<void> {
    await this.redis.del(this.key(id));
  }
}
