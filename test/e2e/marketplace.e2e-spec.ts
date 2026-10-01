import { Test } from '@nestjs/testing';
import { ExpressAdapter, NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { NEST_APP_OPTIONS, configureApp } from '../../src/bootstrap';
import { Queryable } from '../../src/repositories/types';
import { aProduct, insertProduct, insertUser } from '../support/builders';
import {
  TestDatabase,
  appEnvFor,
  startTestDatabase,
  truncateAll,
} from '../support/testkit';

/**
 * E2E: наскрізний сценарій головної фічі через HTTP, на повному застосунку.
 *
 * Жодних підмін провайдерів: Test.createTestingModule({ imports: [AppModule] })
 * піднімає рівно те, що йде в прод, а configureApp() ставить ті самі middleware,
 * що й main.ts — порядок json → express-openapi-validator → роути і глобальний
 * problem+json фільтр. Саме завдяки цьому негативні кейси тут справжні: 400
 * віддає валідатор зі спеки ДЗ-09, а не вигаданий у тесті мок.
 *
 * База — з testcontainers; застосунок отримує її через оточення, тим самим
 * шляхом конфігурації, що й у проді (DB_URL без пароля + DB_PASSWORD_FILE).
 */
describe('Marketplace API (e2e)', () => {
  let db: TestDatabase;
  let app: NestExpressApplication;
  let productId: string;

  beforeAll(async () => {
    db = await startTestDatabase();

    // Оточення треба виставити ДО того, як завантажиться app.module:
    // ConfigModule.forRoot(validate) відпрацьовує на етапі завантаження модуля,
    // тож статичний import тут не підійшов би — лише динамічний.
    const env = appEnvFor(db.uri);
    process.env.DB_URL = env.DB_URL;
    process.env.DB_PASSWORD_FILE = env.DB_PASSWORD_FILE;
    process.env.NODE_ENV = 'test';
    process.env.VALIDATE_RESPONSES = 'true';

    const { AppModule } = await import('../../src/app.module');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    // Адаптер передаємо явно: перевантаження createNestApplication з опціями
    // вимагає його першим аргументом.
    app = moduleRef.createNestApplication<NestExpressApplication>(
      new ExpressAdapter(),
      NEST_APP_OPTIONS,
    );
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    // Без цих двох рядків jest висить: лишаються відкритими http-сервер і пул.
    await app?.close();
    await db?.stop();
  });

  beforeEach(async () => {
    // Ізоляція e2e — TRUNCATE: застосунок ходить у базу власним пулом, і
    // транзакція тесту для нього невидима, тож ROLLBACK тут не працює.
    await truncateAll(db.pool);
    const sellerId = await insertUser(db.pool as unknown as Queryable);
    productId = await insertProduct(
      db.pool as unknown as Queryable,
      sellerId,
      aProduct({ name: 'Шкіряні кросівки', priceCents: 249_900, stock: 5 }),
    );
  });

  it('happy path: створити замовлення і прочитати його назад', async () => {
    // Крок 0: товар видно в каталозі (він справді приїхав із Postgres).
    const catalog = await request(app.getHttpServer()).get('/products?limit=10').expect(200);
    expect(catalog.body.items).toHaveLength(1);
    expect(catalog.body.items[0]).toMatchObject({
      id: productId,
      name: 'Шкіряні кросівки',
      price_cents: 249_900,
      currency: 'UAH',
    });

    // Крок 1: створити.
    const created = await request(app.getHttpServer())
      .post('/orders')
      .set('Idempotency-Key', `e2e-${Date.now()}`)
      .send({ items: [{ product_id: productId, quantity: 2 }] })
      .expect(201);

    expect(created.body).toMatchObject({
      status: 'created',
      currency: 'UAH',
      // сума порахована сервером із ціни в БД, а не прийшла з запиту
      total_cents: 2 * 249_900,
    });
    expect(created.body.items).toEqual([{ product_id: productId, quantity: 2 }]);

    // Крок 2: прочитати назад за id із відповіді.
    const read = await request(app.getHttpServer())
      .get(`/orders/${created.body.id}`)
      .expect(200);

    expect(read.body).toEqual(created.body);
  });

  it('негативний кейс: неіснуючий товар дає 404 у форматі problem+json', async () => {
    const res = await request(app.getHttpServer()).get('/products/999999999').expect(404);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({
      status: 404,
      title: 'Not Found',
      instance: '/products/999999999',
    });
  });

  it('негативний кейс: без Idempotency-Key запит відбиває валідатор зі спеки (400)', async () => {
    const res = await request(app.getHttpServer())
      .post('/orders')
      .send({ items: [{ product_id: productId, quantity: 1 }] })
      .expect(400);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.detail).toMatch(/idempotency-key/i);
  });

  it('негативний кейс: порожній кошик теж 400 — minItems зі спеки', async () => {
    const res = await request(app.getHttpServer())
      .post('/orders')
      .set('Idempotency-Key', `e2e-empty-${Date.now()}`)
      .send({ items: [] })
      .expect(400);

    expect(res.body.status).toBe(400);
  });
});
