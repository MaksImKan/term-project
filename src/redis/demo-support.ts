import type Redis from 'ioredis';

/**
 * Спільна частина чотирьох демо ДЗ-23.
 *
 * Контракт виводу жорсткий: один рядок = `ключ=число`, БЕЗ пробілів усередині
 * рядка — грейдер шукає рядок цілком через `grep -qx`.
 */

export interface Invariant {
  what: string;
  ok: boolean;
}

export function report(values: Record<string, number>, invariants: Invariant[]): never {
  for (const [key, value] of Object.entries(values)) console.log(`${key}=${value}`);

  const broken = invariants.filter((i) => !i.ok);
  if (broken.length === 0) {
    console.log(`\n✔ інваріант витримано: ${invariants.map((i) => i.what).join('; ')}`);
    process.exit(0);
  }

  console.error('\n✖ інваріант порушено:');
  for (const invariant of broken) console.error(`  — ${invariant.what}`);
  process.exit(1);
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Прибрати ключі свого простору імен — щоб демо можна було ганяти повторно.
 *
 * SCAN, а не FLUSHDB: демо не має права зносити чужі дані в інстансі, навіть
 * якщо локально він «нічий».
 */
export async function deleteByPrefix(redis: Redis, prefix: string): Promise<number> {
  let cursor = '0';
  let removed = 0;

  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) removed += await redis.del(...keys);
  } while (cursor !== '0');

  return removed;
}

export async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  stepMs = 25,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(stepMs);
  }
  return condition();
}
