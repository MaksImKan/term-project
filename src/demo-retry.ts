import 'reflect-metadata';
import { DataSource } from 'typeorm';
import type { DemoOutcome } from './demo-support';
import { assertSeeded, finish, openDataSource, sleep } from './demo-support';
import { withRetry, type RetryAttemptLog } from './retry';
import { USERS } from './seed';

/**
 * Serialization failure і retry-патерн.
 *
 *   npm run demo:retry
 *
 * Сценарій — класичний read-modify-write: прочитати баланс, порахувати нове
 * значення в застосунку, записати. Це те, чого в checkout свідомо НЕМА (там
 * атомарний UPDATE), але в реальному коді такі місця бувають: коли нове
 * значення не виражається в SQL — скидка за історією, звірка з платіжкою,
 * перерахунок бонусів.
 *
 * Демо показує обидві половини правди:
 *
 *   Фаза A, READ COMMITTED без нічого — апдейти ТИХО губляться. Друга
 *   транзакція чекає на локі, а потім записує значення, яке порахувала зі
 *   старого прочитаного. Помилки немає, гроші зникли.
 *
 *   Фаза B, REPEATABLE READ + retry — Postgres відмовляється виконати такий
 *   апдейт і віддає 40001. Обгортка ловить рівно цей код, повторює транзакцію
 *   ЦІЛКОМ (разом із читанням!) і арифметика сходиться.
 */

const BUYER_ID = USERS[0].id!;
const START_BALANCE_CENTS = 1_000_000;
const DECREMENT_CENTS = 100;
const CONCURRENCY = 8;
/** Пауза між читанням і записом: розширює вікно, у якому й живе конфлікт. */
const THINK_MS = 25;

async function setBalance(ds: DataSource, cents: number): Promise<void> {
  await ds.query('UPDATE users SET balance_cents = $2 WHERE id = $1', [BUYER_ID, cents]);
}

async function readBalance(ds: DataSource): Promise<number> {
  const rows = (await ds.query('SELECT balance_cents FROM users WHERE id = $1', [
    BUYER_ID,
  ])) as Array<{ balance_cents: number }>;
  return Number(rows[0].balance_cents);
}

/**
 * Одна транзакція read-modify-write на заданому рівні ізоляції.
 * Нове значення рахується в JS — саме тут і живе конфлікт.
 */
async function readModifyWrite(
  ds: DataSource,
  isolation: 'READ COMMITTED' | 'REPEATABLE READ',
): Promise<void> {
  await ds.transaction(isolation, async (manager) => {
    const rows = (await manager.query(
      'SELECT balance_cents FROM users WHERE id = $1',
      [BUYER_ID],
    )) as Array<{ balance_cents: number }>;

    const current = Number(rows[0].balance_cents);
    await sleep(THINK_MS);

    // Записуємо порахуване зі СТАРОГО прочитаного значення.
    await manager.query('UPDATE users SET balance_cents = $2 WHERE id = $1', [
      BUYER_ID,
      current - DECREMENT_CENTS,
    ]);
  });
}

async function main(): Promise<DemoOutcome> {
  const ds = await openDataSource(CONCURRENCY + 2);

  try {
    await assertSeeded(ds);

    const expected = START_BALANCE_CENTS - CONCURRENCY * DECREMENT_CENTS;

    console.log('── demo:retry ──');
    console.log(
      `${CONCURRENCY} паралельних read-modify-write по -${DECREMENT_CENTS} коп. ` +
        `зі старту ${START_BALANCE_CENTS}; очікуємо ${expected}\n`,
    );

    // ── Фаза A: як це ламається на READ COMMITTED ──
    await setBalance(ds, START_BALANCE_CENTS);
    const lostSettled = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () => readModifyWrite(ds, 'READ COMMITTED')),
    );
    const lostErrors = lostSettled.filter((r) => r.status === 'rejected').length;
    const lostBalance = await readBalance(ds);
    const lost = (lostBalance - expected) / DECREMENT_CENTS;

    console.log('Фаза A — READ COMMITTED, без retry:');
    console.log(`  помилок: ${lostErrors}`);
    console.log(`  баланс: ${lostBalance}, очікували ${expected}`);
    console.log(
      lost > 0
        ? `  ⇒ втрачено апдейтів: ${lost} — тихо, без жодної помилки\n`
        : '  ⇒ цього разу збіг не спрацював, апдейти не загубились\n',
    );

    // ── Фаза B: REPEATABLE READ + retry ──
    await setBalance(ds, START_BALANCE_CENTS);

    const allRetries: RetryAttemptLog[] = [];
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        withRetry(() => readModifyWrite(ds, 'REPEATABLE READ'), {
          label: `tx-${i + 1}`,
          // 8 транзакцій на один рядок — під кінець черги комусь треба з десяток
          // спроб. Дефолтних шести вистачає не завжди, і це не привід падати.
          maxAttempts: 12,
          onRetry: (log) => {
            allRetries.push(log);
            console.log(
              `  ↻ tx-${i + 1}: спроба ${log.attempt} впала з ${log.code} ` +
                `(${log.message}) → повтор через ${log.delayMs} мс`,
            );
          },
        }),
      ),
    );

    const finalBalance = await readBalance(ds);
    const totalAttempts = results.reduce((sum, r) => sum + r.attempts, 0);
    const codes = new Map<string, number>();
    for (const log of allRetries) codes.set(log.code, (codes.get(log.code) ?? 0) + 1);

    console.log('\nФаза B — REPEATABLE READ + retry-обгортка:');
    console.table({
      'транзакцій': CONCURRENCY,
      'усього спроб': totalAttempts,
      'повторів': allRetries.length,
      'пійманих кодів': [...codes].map(([c, n]) => `${c}×${n}`).join(', ') || '—',
      'баланс': finalBalance,
      'очікували': expected,
    });

    const problems: string[] = [];
    if (finalBalance !== expected) {
      problems.push(`фінальний баланс ${finalBalance}, а має бути ${expected}`);
    }
    if (allRetries.length === 0) {
      problems.push('жодного повтору не сталося — конфлікт не спровокувався, демо нічого не довело');
    }
    for (const code of codes.keys()) {
      if (code !== '40001' && code !== '40P01') {
        problems.push(`піймано код ${code}, а обгортка має ловити лише 40001 і 40P01`);
      }
    }

    if (problems.length > 0) {
      for (const problem of problems) console.error(`  ✖ ${problem}`);
      return { ok: false, summary: 'retry не витримав перевірки' };
    }

    return {
      ok: true,
      summary:
        `піймано ${allRetries.length} конфліктів (${[...codes].map(([c, n]) => `${c}×${n}`).join(', ')}), ` +
        `${totalAttempts} спроб на ${CONCURRENCY} транзакцій, баланс ${finalBalance} = очікуваний`,
    };
  } finally {
    await ds.destroy().catch(() => undefined);
  }
}

main()
  .then(finish)
  .catch((error: unknown) => {
    console.error('\n✖ demo:retry не відпрацював.\n');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
