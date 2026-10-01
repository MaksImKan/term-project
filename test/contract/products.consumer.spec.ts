import * as path from 'node:path';
import { MatchersV3, PactV3 } from '@pact-foundation/pact';

const { string, integer, eachLike, regex } = MatchersV3;

/**
 * Consumer-тест: уявний фронтенд описує, чого він чекає від Marketplace API.
 *
 * Це не тест провайдера і не тест фронтенду — це ЗАПИС ОЧІКУВАНЬ. Результат —
 * pacts/marketplace-web-marketplace-api.json, який потім перевіряється проти
 * справжнього застосунку (test/contract/*provider*).
 *
 * Шляхи взяті зі спеки ДЗ-09 (openapi/openapi.yaml): /products і
 * /products/{productId}. Значення описані матчерами, а не константами:
 * контракт має ламатися від зміни ФОРМИ відповіді, а не від того, що в базі
 * зʼявився інший товар.
 */
const pact = new PactV3({
  consumer: 'marketplace-web',
  provider: 'marketplace-api',
  dir: path.resolve(process.cwd(), 'pacts'),
  logLevel: 'warn',
});

const PRODUCT_ID = '1';

describe('marketplace-web → marketplace-api (consumer contract)', () => {
  it('читає картку товару за id', async () => {
    pact
      // provider state: що провайдер має зробити з БД, щоб ця взаємодія мала сенс.
      // Параметри приїдуть у stateHandler провайдера, тож фронтенд не вгадує id.
      .given('товар існує', { id: PRODUCT_ID, name: 'Шкіряні кросівки', priceCents: 249900 })
      .uponReceiving('запит картки товару')
      .withRequest({ method: 'GET', path: `/products/${PRODUCT_ID}` })
      .willRespondWith({
        status: 200,
        headers: { 'Content-Type': regex(/application\/json.*/, 'application/json; charset=utf-8') },
        body: {
          id: string(PRODUCT_ID),
          name: string('Шкіряні кросівки'),
          // Гроші — ціле число копійок, і контракт фіксує саме це.
          price_cents: integer(249900),
          currency: string('UAH'),
        },
      });

    await pact.executeTest(async (mockServer) => {
      const response = await fetch(`${mockServer.url}/products/${PRODUCT_ID}`);
      expect(response.status).toBe(200);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ id: PRODUCT_ID, currency: 'UAH' });
      expect(typeof body.price_cents).toBe('number');
    });
  });

  it('читає сторінку каталогу з курсором', async () => {
    pact
      .given('у каталозі є щонайменше один товар')
      .uponReceiving('запит сторінки каталогу')
      .withRequest({ method: 'GET', path: '/products', query: { limit: '2' } })
      .willRespondWith({
        status: 200,
        headers: { 'Content-Type': regex(/application\/json.*/, 'application/json; charset=utf-8') },
        body: {
          items: eachLike({
            id: string(PRODUCT_ID),
            name: string('Шкіряні кросівки'),
            price_cents: integer(249900),
            currency: string('UAH'),
          }),
          // next_cursor — непрозорий токен або null, коли сторінок більше немає.
          next_cursor: null,
        },
      });

    await pact.executeTest(async (mockServer) => {
      const response = await fetch(`${mockServer.url}/products?limit=2`);
      expect(response.status).toBe(200);

      const body = (await response.json()) as { items: unknown[]; next_cursor: string | null };
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items.length).toBeGreaterThan(0);
    });
  });
});
