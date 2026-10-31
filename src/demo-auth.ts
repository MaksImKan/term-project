import 'reflect-metadata';
import { call, cleanupUsers, createUser, login, report, startApi } from './auth/demo-support';

/**
 * demo:auth — логаут прибиває ОБИДВА токени.
 *
 *   bash scripts/with-secrets.sh dev node dist/demo-auth.js
 *
 * Чому це не одне й те саме і чому логаут — дві дії:
 *   refresh — рядок у базі, його досить позначити відкликаним;
 *   access  — self-contained і живе до `exp`, скільки б разів користувач не
 *             натиснув «вийти». Без денилиста `after-logout` віддав би 200, і
 *             «вихід» був би написом на кнопці.
 *
 * Обидві дії йдуть однією транзакцією: позначка в одному сховищі, а ефект в
 * іншому — це той самий dual write, від якого ми тікали в ДЗ-22.
 */
async function main(): Promise<never> {
  const api = await startApi();
  const created: string[] = [];

  try {
    const user = await createUser(api.dataSource, 'buyer');
    created.push(user.id);

    // ── Логін ───────────────────────────────────────────────────────────────
    const session = await login(api.baseUrl, user);
    console.log(`[demo] логін: ${session.status}`);

    // ── Без токена ресурс закритий ──────────────────────────────────────────
    const anon = await call(api.baseUrl, '/account/orders/1');
    console.log(`[demo] без токена: ${anon.status}`);

    // ── З токеном пускає (чужого замовлення немає -> 404, але НЕ 401) ──────
    const ownOrder = (await api.dataSource.query(
      `INSERT INTO orders (buyer_id, status, total_cents, currency)
       VALUES ($1, 'pending', 1000, 'UAH') RETURNING id`,
      [user.id],
    )) as Array<{ id: string }>;
    const withToken = await call(api.baseUrl, `/account/orders/${ownOrder[0].id}`, {
      token: session.access,
    });
    console.log(`[demo] з токеном: ${withToken.status}`);

    // ── Ротація ─────────────────────────────────────────────────────────────
    const refreshed = await call(api.baseUrl, '/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: session.refresh }),
    });
    const rotated = refreshed.body as { access_token?: string; refresh_token?: string } | null;
    console.log(`[demo] рефреш: ${refreshed.status}`);

    // ── Логаут ──────────────────────────────────────────────────────────────
    const logout = await call(api.baseUrl, '/auth/logout', {
      method: 'POST',
      token: rotated?.access_token ?? session.access,
    });
    console.log(`[demo] логаут: ${logout.status}`);

    // ── Після логауту не працює НІЧОГО ──────────────────────────────────────
    const afterLogout = await call(api.baseUrl, `/account/orders/${ownOrder[0].id}`, {
      token: rotated?.access_token ?? session.access,
    });
    const refreshAfterLogout = await call(api.baseUrl, '/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: rotated?.refresh_token ?? session.refresh }),
    });
    console.log(
      `[demo] після логауту: access ${afterLogout.status}, refresh ${refreshAfterLogout.status}`,
    );

    await cleanupUsers(api.dataSource, created);
    await api.stop();

    return report(
      {
        login: session.status,
        'no-token': anon.status,
        'with-token': withToken.status,
        refresh: refreshed.status,
        logout: logout.status,
        'after-logout': afterLogout.status,
        'refresh-after-logout': refreshAfterLogout.status,
      },
      [
        { what: 'логін віддав пару токенів', ok: session.status === 200 },
        { what: 'без токена — 401', ok: anon.status === 401 },
        { what: 'з токеном — 200', ok: withToken.status === 200 },
        { what: 'ротація спрацювала', ok: refreshed.status === 200 },
        { what: 'логаут 200 або 204', ok: logout.status === 200 || logout.status === 204 },
        { what: 'access після логауту мертвий (денилист)', ok: afterLogout.status === 401 },
        { what: 'refresh після логауту мертвий (сімʼя)', ok: refreshAfterLogout.status === 401 },
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
