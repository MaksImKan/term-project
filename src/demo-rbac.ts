import 'reflect-metadata';
import {
  call,
  cleanupUsers,
  createOrderFor,
  createUser,
  login,
  report,
  startApi,
  tamperRole,
} from './auth/demo-support';

/**
 * demo:rbac — 401 ≠ 403, власність, роль і перевірка підпису.
 *
 *   bash scripts/with-secrets.sh dev node dist/demo-rbac.js
 *
 * Пара `anon=401` + `foreign=403` і є розділенням двох дисциплін:
 *   401 — ми не знаємо, хто це (немає/протух/зіпсований токен). Клієнтський
 *         SDK на це йде рефрешити токен;
 *   403 — ми знаємо, хто це, і йому не можна. Рефреш тут не допоможе, тож SDK
 *         має показати помилку.
 * Рішення, яке віддає 403 в обох випадках, зациклює клієнта на рефреші.
 *
 * Два рівні авторизації перевіряються окремо:
 *   власність — чуже замовлення під валідним токеном покупця;
 *   роль      — запис у каталог покупцем проти запису продавцем.
 *
 * `tampered` — токен із підміненим payload (`role` -> admin) і СТАРИМ
 * підписом. Рішення на `jwt.decode()` віддало б тут 201; у нас 401, бо
 * верифікація йде з явним allowlist алгоритмів.
 */
async function main(): Promise<never> {
  const api = await startApi();
  const created: string[] = [];

  try {
    const buyer = await createUser(api.dataSource, 'buyer');
    const other = await createUser(api.dataSource, 'buyer');
    const seller = await createUser(api.dataSource, 'seller');
    created.push(buyer.id, other.id, seller.id);

    const ownOrder = await createOrderFor(api.dataSource, buyer.id);
    const foreignOrder = await createOrderFor(api.dataSource, other.id);

    const buyerSession = await login(api.baseUrl, buyer);
    const sellerSession = await login(api.baseUrl, seller);

    // ── Автентифікація: є токен чи немає ────────────────────────────────────
    const anon = await call(api.baseUrl, `/account/orders/${ownOrder}`);
    console.log(`[demo] без токена: ${anon.status}`);

    // ── Авторизація, рівень власності ───────────────────────────────────────
    const own = await call(api.baseUrl, `/account/orders/${ownOrder}`, {
      token: buyerSession.access,
    });
    const foreign = await call(api.baseUrl, `/account/orders/${foreignOrder}`, {
      token: buyerSession.access,
    });
    console.log(`[demo] своє: ${own.status}, чуже: ${foreign.status}`);

    // ── Авторизація, рівень ролі ────────────────────────────────────────────
    const product = JSON.stringify({
      name: 'Демо-товар',
      description: 'створено demo:rbac',
      price_cents: 12345,
      stock: 3,
    });
    const roleDenied = await call(api.baseUrl, '/products', {
      method: 'POST',
      body: product,
      token: buyerSession.access,
    });
    const roleAllowed = await call(api.baseUrl, '/products', {
      method: 'POST',
      body: product,
      token: sellerSession.access,
    });
    console.log(`[demo] покупець пише в каталог: ${roleDenied.status}`);
    console.log(`[demo] продавець пише в каталог: ${roleAllowed.status}`);

    // ── Підроблений токен ───────────────────────────────────────────────────
    const tamperedToken = tamperRole(buyerSession.access, 'admin');
    const tampered = await call(api.baseUrl, '/products', {
      method: 'POST',
      body: product,
      token: tamperedToken,
    });
    console.log(`[demo] підроблений payload зі старим підписом: ${tampered.status}`);

    // Прибираємо створений товар, щоб демо не засмічувало каталог.
    const createdProductId = (roleAllowed.body as { id?: string } | null)?.id;
    if (createdProductId) {
      await api.dataSource.query('DELETE FROM products WHERE id = $1', [createdProductId]);
    }

    await cleanupUsers(api.dataSource, created);
    await api.stop();

    return report(
      {
        anon: anon.status,
        own: own.status,
        foreign: foreign.status,
        'role-denied': roleDenied.status,
        'role-allowed': roleAllowed.status,
        tampered: tampered.status,
      },
      [
        { what: 'без токена — 401 (не знаємо, хто це)', ok: anon.status === 401 },
        { what: 'своє замовлення — 200', ok: own.status === 200 },
        { what: 'чуже замовлення — 403 (знаємо, хто це, і не можна)', ok: foreign.status === 403 },
        { what: 'покупцю заборонено писати в каталог — 403', ok: roleDenied.status === 403 },
        {
          what: 'продавцю дозволено — 200 або 201',
          ok: roleAllowed.status === 200 || roleAllowed.status === 201,
        },
        { what: 'підроблений payload — 401, бо підпис перевіряється', ok: tampered.status === 401 },
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
