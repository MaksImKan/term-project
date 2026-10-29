import 'reflect-metadata';
import { openDataSource } from './demo-support';
import { CacheAside } from './redis/cache';
import { connectCache, evictionPolicy, maxMemoryBytes } from './redis/connections';
import { deleteByPrefix, report } from './redis/demo-support';
import { ProductCardRepository, cardKey } from './redis/product-card';
import { PRODUCTS } from './seed';

/**
 * demo:cache — кеш економить походи в базу, а лавина дає рівно один.
 *
 *   bash scripts/with-secrets.sh dev node dist/demo-cache.js
 *
 * Три різні твердження, і кожне перевіряється окремо:
 *
 *  1. Інстанс справді налаштований як КЕШ — maxmemory > 0 і політика не
 *     noeviction. Читається з живого зʼєднання, а не з конфіга в репозиторії.
 *  2. TTL має джитер: 60 прогрітих ключів дають десятки різних TTL. Без
 *     джитера було б рівно одне значення — і всі вони протухли б в одну
 *     секунду.
 *  3. На щойно зниклий ключ 25 одночасних читань дають ОДИН похід у базу
 *     (лічильник живе в репозиторії, поруч із SQL), а наступні 100 читань
 *     теплого кеша — жодного.
 */
const WARM_KEYS = 60;
const CONCURRENT = 25;
const WARM_READS = 100;
const PRODUCT_ID = PRODUCTS[0].id!;

async function main(): Promise<never> {
  const dataSource = await openDataSource(CONCURRENT + 5);
  const redis = connectCache();

  try {
    const policy = await evictionPolicy(redis);
    const maxmemory = await maxMemoryBytes(redis);
    console.log(`[demo] кеш-інстанс: maxmemory-policy=${policy}, maxmemory=${maxmemory}`);

    const cache = new CacheAside(redis);
    const repo = new ProductCardRepository(dataSource);

    // Чистий аркуш у власному просторі імен.
    await deleteByPrefix(redis, 'card:v1:');
    await deleteByPrefix(redis, 'lock:card:v1:');

    // ── 1. Прогрів: скільки різних TTL дає джитер ────────────────────────────
    // Кожен ключ — свій, бо перезапис тих самих імен нічого б не показав.
    const card = await repo.load(PRODUCT_ID);
    if (!card) throw new Error(`товару ${PRODUCT_ID} немає — спершу npm run seed`);

    for (let i = 0; i < WARM_KEYS; i += 1) {
      await cache.set(cardKey(`warm-${i}`), { ...card, id: `warm-${i}` });
    }

    const ttls = await Promise.all(
      Array.from({ length: WARM_KEYS }, (_, i) => redis.ttl(cardKey(`warm-${i}`))),
    );
    const distinct = new Set(ttls.filter((ttl) => ttl > 0)).size;
    console.log(`[demo] TTL прогрітих ключів: від ${Math.min(...ttls)} до ${Math.max(...ttls)}`);

    // ── 2. Лавина на холодний ключ ──────────────────────────────────────────
    const hotKey = cardKey(PRODUCT_ID);
    await redis.del(hotKey);
    repo.resetCounter();

    const results = await Promise.all(
      Array.from({ length: CONCURRENT }, () => cache.read(hotKey, () => repo.load(PRODUCT_ID))),
    );
    const dbCalls = repo.dbCalls;
    const allSame = results.every((r) => r && (r as { id: string }).id === card.id);

    // ── 3. Теплий кеш не чіпає базу взагалі ─────────────────────────────────
    repo.resetCounter();
    for (let i = 0; i < WARM_READS; i += 1) {
      await cache.read(hotKey, () => repo.load(PRODUCT_ID));
    }
    const dbCallsWarm = repo.dbCalls;

    await redis.quit();
    await dataSource.destroy();

    return report(
      {
        'cache-lru': policy !== 'noeviction' ? 1 : 0,
        'cache-maxmemory': maxmemory > 0 ? 1 : 0,
        warmed: WARM_KEYS,
        'ttl-distinct': distinct,
        concurrent: CONCURRENT,
        'db-calls': dbCalls,
        'db-calls-warm': dbCallsWarm,
      },
      [
        { what: 'інстанс налаштований як кеш (maxmemory + витіснення)', ok: policy !== 'noeviction' && maxmemory > 0 },
        { what: `прогріто ${WARM_KEYS} ключів`, ok: WARM_KEYS >= 50 },
        { what: 'джитер дає різні TTL', ok: distinct >= 5 },
        { what: `${CONCURRENT} одночасних читань дали один похід у базу`, ok: dbCalls === 1 },
        { what: 'теплий кеш не ходив у базу жодного разу', ok: dbCallsWarm === 0 },
        { what: 'усі конкуренти отримали те саме значення', ok: allSame },
      ],
    );
  } catch (error) {
    await redis.quit().catch(() => undefined);
    await dataSource.destroy().catch(() => undefined);
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
