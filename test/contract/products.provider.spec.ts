import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { ExpressAdapter, NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Verifier } from '@pact-foundation/pact';
import { NEST_APP_OPTIONS, configureApp } from '../../src/bootstrap';
import { TestDatabase, appEnvFor, startTestDatabase } from '../support/testkit';

/**
 * Provider verification: СПРАВЖНІЙ застосунок проти контракту консюмера.
 *
 *   npm run verify:provider                                    # локальний пакт
 *   PACT_BROKER_URL=… npm run verify:provider                  # з брокера, з публікацією
 *   bash scripts/with-secrets.sh dev npm run verify:provider   # адреса й токен зі сховища
 *
 * Жодних моків: піднімається AppModule із configureApp() (той самий набір
 * middleware, що в main.ts), база — з testcontainers, а provider states сідають
 * її через stateHandlers. Якщо відповідь застосунку розійдеться з контрактом,
 * верифікація впаде — і це єдиний спосіб дізнатися про поломку до того, як її
 * знайде фронтенд.
 *
 * Адреса й токен брокера читаються ЛИШЕ з process.env: локально їх підкладає
 * обгортка сховища (ДЗ-11), у CI — secrets GitHub. У коді їх немає.
 */

const PACT_FILE = path.resolve(
  process.cwd(),
  'pacts',
  'marketplace-web-marketplace-api.json',
);

/** Версія провайдера. Саме її потім тегають як prod для can-i-deploy. */
function providerVersion(): string {
  if (process.env.PROVIDER_VERSION) return process.env.PROVIDER_VERSION;
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return '0.0.0-local';
  }
}

describe('marketplace-api (provider verification)', () => {
  let db: TestDatabase;
  let app: NestExpressApplication;
  let baseUrl: string;

  beforeAll(async () => {
    db = await startTestDatabase();

    const env = appEnvFor(db.uri);
    process.env.DB_URL = env.DB_URL;
    process.env.DB_PASSWORD_FILE = env.DB_PASSWORD_FILE;
    process.env.NODE_ENV = 'test';
    process.env.VALIDATE_RESPONSES = 'true';

    const { AppModule } = await import('../../src/app.module');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>(
      new ExpressAdapter(),
      NEST_APP_OPTIONS,
    );
    configureApp(app);

    // Верифаєр ходить справжнім HTTP, тож застосунок мусить слухати порт.
    // 0 — нехай ОС дасть вільний: інакше паралельні прогони б'ються за порт.
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app?.close();
    await db?.stop();
  });

  /**
   * Provider state: привести БД у стан, за якого взаємодія має сенс.
   * TRUNCATE + ON CONFLICT DO NOTHING — щоб верифікацію можна було ганяти
   * скільки завгодно разів підряд і щоразу отримувати той самий результат.
   */
  async function seedProduct(params: Record<string, unknown> = {}): Promise<void> {
    const id = String(params.id ?? '1');
    const name = String(params.name ?? 'Шкіряні кросівки');
    const priceCents = Number(params.priceCents ?? 249900);

    await db.pool.query(
      'TRUNCATE tasks, order_items, orders, products, users RESTART IDENTITY CASCADE',
    );
    await db.pool.query(
      `INSERT INTO users (id, email, full_name, city, balance_cents)
       VALUES (1, 'seller@example.com', 'Продавець Vesna', 'Київ', 0)
       ON CONFLICT (id) DO NOTHING`,
    );
    await db.pool.query(
      `INSERT INTO products (id, seller_id, name, description, price_cents, currency, stock)
       VALUES ($1, 1, $2, $3, $4, 'UAH', 10)
       ON CONFLICT (id) DO NOTHING`,
      [id, name, `Оригінальні ${name.toLowerCase()} від бренду Vesna.`, priceCents],
    );
    // Явні id не рухають IDENTITY — вирівнюємо послідовності, щоб наступна
    // автоматична вставка не впала на дублікаті ключа.
    await db.pool.query(
      `SELECT setval(pg_get_serial_sequence('products', 'id'),
                     GREATEST((SELECT max(id) FROM products), 1))`,
    );
    await db.pool.query(
      `SELECT setval(pg_get_serial_sequence('users', 'id'),
                     GREATEST((SELECT max(id) FROM users), 1))`,
    );
  }

  /**
   * Верифаєр (Rust-ядро pact) ходить до провайдера і до брокера звичайним
   * HTTP-клієнтом, і той поважає HTTP_PROXY/HTTPS_PROXY з оточення. У мережах,
   * де проксі є (корпоративний периметр, CI-раннер у sandbox-і), запит на
   * 127.0.0.1 іде через проксі й повертається 403 з тілом
   * «request blocked: no rule allows host 127.0.0.1» — верифікація падає на
   * BodyTypeMismatch, хоча застосунок цілком здоровий.
   *
   * І провайдер, і локальний брокер із docker-compose живуть на 127.0.0.1, тож
   * проксі тут не потрібен узагалі. PACT_KEEP_PROXY=1 лишає його на місці — для
   * випадку, коли брокер справді за периметром.
   */
  function bypassProxyForLocalhost(): void {
    if (process.env.PACT_KEEP_PROXY === '1') return;
    for (const key of [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy',
    ]) {
      delete process.env[key];
    }
    const noProxy = new Set((process.env.NO_PROXY ?? '').split(',').filter(Boolean));
    noProxy.add('127.0.0.1');
    noProxy.add('localhost');
    process.env.NO_PROXY = [...noProxy].join(',');
    process.env.no_proxy = process.env.NO_PROXY;
  }

  it('відповідає на всі interactions контракту', async () => {
    bypassProxyForLocalhost();

    const brokerUrl = process.env.PACT_BROKER_URL;
    const version = providerVersion();

    // pacts/ у .gitignore: контракт — артефакт consumer-тесту, тож на свіжому
    // клоні його просто ще немає. Помилка верифаєра про «no pacts found» тут
    // нічого не пояснює, тому кажемо прямо, що запустити.
    if (!brokerUrl && !existsSync(PACT_FILE)) {
      throw new Error(
        `Контракту немає: ${PACT_FILE}\n` +
          'Він генерується consumer-тестом (pacts/ у .gitignore — це артефакт, не код).\n' +
          'Спочатку: npm run test:contract\n' +
          'Або візьміть контракт із брокера: PACT_BROKER_URL=http://127.0.0.1:9292 npm run verify:provider',
      );
    }

    console.log(`  providerVersion: ${version}`);
    console.log(`  джерело контракту: ${brokerUrl ? `брокер ${brokerUrl}` : `файл ${PACT_FILE}`}`);

    const verifier = new Verifier({
      provider: 'marketplace-api',
      providerBaseUrl: baseUrl,
      providerVersion: version,
      logLevel: 'warn',

      // StateFunc у pact-js 17: (parameters?) => Promise<JsonMap | void>.
      // Параметри приїжджають із `given(..., params)` консюмера, тож id товару
      // задає контракт, а не вгадує провайдер.
      stateHandlers: {
        'товар існує': async (params) => {
          await seedProduct((params ?? {}) as Record<string, unknown>);
        },
        'у каталозі є щонайменше один товар': async () => {
          await seedProduct();
        },
      },

      // Є брокер — беремо контракт звідти й публікуємо результат перевірки
      // (саме з цього потім живе can-i-deploy). Немає — читаємо локальний файл.
      ...(brokerUrl
        ? {
            pactBrokerUrl: brokerUrl,
            publishVerificationResult: true,
            consumerVersionSelectors: [{ latest: true }],
            // Ключ додаємо ЛИШЕ якщо токен справді є: pact-js валідує опції
            // за наявністю ключа, а не за значенням, і на
            // `pactBrokerToken: undefined` падає з «TypeError: pactBrokerToken».
            // Локальний брокер зі стенда авторизації не має — токена там немає.
            ...(process.env.PACT_BROKER_TOKEN
              ? { pactBrokerToken: process.env.PACT_BROKER_TOKEN }
              : {}),
          }
        : { pactUrls: [PACT_FILE] }),
    });

    await expect(verifier.verifyProvider()).resolves.toBeDefined();
  });
});
