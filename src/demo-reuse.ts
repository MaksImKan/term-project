import 'reflect-metadata';
import { call, cleanupUsers, createUser, login, report, startApi } from './auth/demo-support';

/**
 * demo:reuse — повторне використання refresh-токена валить УСЮ СІМʼЮ.
 *
 *   bash scripts/with-secrets.sh dev node dist/demo-reuse.js
 *
 * Сценарій рівно такий, як у житті:
 *   r1 — токен, який украли. Злодій (або чесний клієнт) рефрешиться першим і
 *        отримує r2.
 *   r1 знову — предʼявлення вже використаного токена. Це не помилка клієнта,
 *        це сигнал компрометації: хтось має копію.
 *   r2 після цього — і чесний клієнт теж вилітає.
 *
 * Останній рядок і є весь сенс. `r1-reuse=401` уміє й ротація БЕЗ сімʼї:
 * «старий токен більше не працює». А `r2-after-reuse=401` означає, що після
 * сигналу компрометації відкликано сімʼю цілком — інакше сесія злодія жила б
 * далі, а власник просто мовчки перелогінився б і нічого не помітив.
 *
 * Це рівно те, чого вимагає RFC 9700 §4.14.2: або sender-constrained токен,
 * або ротація з детекцією повтору — і звʼязок між старим і новим токеном
 * зберігається саме для того, щоб виявлений повтор було чим відкликати.
 */
async function main(): Promise<never> {
  const api = await startApi();
  const created: string[] = [];

  try {
    const user = await createUser(api.dataSource, 'buyer');
    created.push(user.id);

    const session = await login(api.baseUrl, user);
    console.log(`[demo] логін: ${session.status}, сімʼя відкрита`);

    // ── r1: перший (і єдиний легальний) рефреш ──────────────────────────────
    const r1 = await call(api.baseUrl, '/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: session.refresh }),
    });
    const r2token = (r1.body as { refresh_token?: string } | null)?.refresh_token ?? '';
    console.log(`[demo] r1 (перший рефреш): ${r1.status}`);

    // ── r1 ще раз: повтор уже використаного токена ──────────────────────────
    const reuse = await call(api.baseUrl, '/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: session.refresh }),
    });
    console.log(`[demo] r1 повторно: ${reuse.status} — сигнал компрометації`);

    // ── r2: чесний клієнт після сигналу ─────────────────────────────────────
    const r2 = await call(api.baseUrl, '/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: r2token }),
    });
    console.log(`[demo] r2 після повтору: ${r2.status} — сімʼя відкликана цілком`);

    // Перевіряємо це ще й у базі: усі токени сімʼї мають revoked_at.
    const [{ alive }] = (await api.dataSource.query(
      `SELECT count(*)::int AS alive FROM refresh_tokens
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [user.id],
    )) as Array<{ alive: number }>;
    console.log(`[demo] живих refresh-токенів у сімʼї: ${alive}`);

    await cleanupUsers(api.dataSource, created);
    await api.stop();

    return report(
      {
        login: session.status,
        'r1-refresh': r1.status,
        'r1-reuse': reuse.status,
        'r2-after-reuse': r2.status,
      },
      [
        { what: 'логін віддав пару', ok: session.status === 200 },
        { what: 'перший рефреш спрацював', ok: r1.status === 200 },
        { what: 'повтор використаного токена — 401', ok: reuse.status === 401 },
        {
          what: 'чесний клієнт теж вилетів — сімʼю відкликано (це і є детекція)',
          ok: r2.status === 401,
        },
        { what: 'у базі не лишилось живих токенів сімʼї', ok: alive === 0 },
      ],
    );
  } catch (error) {
    await cleanupUsers(api.dataSource, created).catch(() => undefined);
    await api.stop().catch(() => undefined);
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
