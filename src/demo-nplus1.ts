import 'reflect-metadata';
import { DataSource, Logger, QueryRunner } from 'typeorm';
import { buildOptions } from './data-source';
import { Order, OrderItem, Product } from './entities';

/**
 * Демонстрація N+1 і трьох способів його не мати.
 *
 *   npm run demo:nplus1
 *
 * Запит домену: «покажи останні замовлення разом із позиціями й товарами» —
 * тобто граф на два рівні: order → items → product. Рівно те, що потрібно
 * будь-якому екрану «мої замовлення».
 *
 * N+1 не видно в коді — він видно тільки в лозі SQL, тому весь підрахунок
 * робить власний Logger, підвішений до DataSource із logging: ['query'].
 */

class QueryCountLogger implements Logger {
  private collecting = false;
  private queries: string[] = [];

  start(): void {
    this.collecting = true;
    this.queries = [];
  }

  stop(): string[] {
    this.collecting = false;
    return this.queries;
  }

  logQuery(query: string): void {
    if (this.collecting) this.queries.push(query);
  }

  // Решта методів інтерфейсу нас не цікавить, але мати їх обовʼязково.
  logQueryError(_e: string | Error, _q: string, _p?: unknown[], _r?: QueryRunner): void {}
  logQuerySlow(_t: number, _q: string, _p?: unknown[], _r?: QueryRunner): void {}
  logSchemaBuild(_m: string, _r?: QueryRunner): void {}
  logMigration(_m: string, _r?: QueryRunner): void {}
  log(_l: 'log' | 'info' | 'warn', _m: unknown, _r?: QueryRunner): void {}
}

const counter = new QueryCountLogger();

const short = (sql: string): string =>
  sql.replace(/\s+/g, ' ').trim().slice(0, 110);

interface Result {
  strategy: string;
  queries: number;
  orders: number;
  items: number;
}

/** Наївно: запит на список, потім запит на КОЖНЕ замовлення і КОЖНУ позицію. */
async function naive(ds: DataSource, take: number): Promise<Result> {
  const orderRepo = ds.getRepository(Order);
  const itemRepo = ds.getRepository(OrderItem);
  const productRepo = ds.getRepository(Product);

  counter.start();

  const orders = await orderRepo.find({ order: { id: 'ASC' }, take });

  let items = 0;
  for (const order of orders) {
    // +1 запит на кожне замовлення
    const orderItems = await itemRepo.find({ where: { orderId: order.id } });
    items += orderItems.length;

    for (const item of orderItems) {
      // ще +1 запит на кожну позицію
      await productRepo.findOne({ where: { id: item.productId } });
    }
  }

  const queries = counter.stop();
  return { strategy: 'наївно (запит у циклі)', queries: queries.length, orders: orders.length, items };
}

/** relations — TypeORM тягне граф одним запитом із LEFT JOIN. */
async function withRelations(ds: DataSource, take: number): Promise<Result> {
  counter.start();

  const orders = await ds.getRepository(Order).find({
    order: { id: 'ASC' },
    take,
    relations: { items: { product: true } },
  });

  const queries = counter.stop();
  return {
    strategy: "relations (join)",
    queries: queries.length,
    orders: orders.length,
    items: orders.reduce((sum, o) => sum + o.items.length, 0),
  };
}

/** Те саме через QueryBuilder — той самий один запит, просто руками. */
async function withJoinAndSelect(ds: DataSource, take: number): Promise<Result> {
  counter.start();

  const orders = await ds
    .getRepository(Order)
    .createQueryBuilder('o')
    .leftJoinAndSelect('o.items', 'i')
    .leftJoinAndSelect('i.product', 'p')
    .orderBy('o.id', 'ASC')
    .take(take)
    .getMany();

  const queries = counter.stop();
  return {
    strategy: 'leftJoinAndSelect',
    queries: queries.length,
    orders: orders.length,
    items: orders.reduce((sum, o) => sum + o.items.length, 0),
  };
}

/**
 * Той самий join, але БЕЗ пагінації — і саме тут виходить канонічна «1».
 * З `take` TypeORM змушений спершу окремим запитом вибрати N різних id
 * кореневої сутності: інакше LIMIT обрізав би рядки ПІСЛЯ join-у, тобто
 * позиції, а не замовлення. Звідси 2 запити замість 1 — це не N+1, число
 * від розміру вибірки не залежить.
 */
async function withRelationsNoTake(ds: DataSource): Promise<Result> {
  counter.start();

  const orders = await ds.getRepository(Order).find({
    order: { id: 'ASC' },
    relations: { items: { product: true } },
  });

  const queries = counter.stop();
  return {
    strategy: 'relations (join), без пагінації',
    queries: queries.length,
    orders: orders.length,
    items: orders.reduce((sum, o) => sum + o.items.length, 0),
  };
}

/** relationLoadStrategy: 'query' — окремий запит на РІВЕНЬ, а не на рядок. */
async function withQueryStrategy(ds: DataSource, take: number): Promise<Result> {
  counter.start();

  const orders = await ds.getRepository(Order).find({
    order: { id: 'ASC' },
    take,
    relations: { items: { product: true } },
    relationLoadStrategy: 'query',
  });

  const queries = counter.stop();
  return {
    strategy: "relationLoadStrategy: 'query'",
    queries: queries.length,
    orders: orders.length,
    items: orders.reduce((sum, o) => sum + o.items.length, 0),
  };
}

async function main(): Promise<void> {
  const ds = await new DataSource({
    ...buildOptions(),
    logging: ['query'],
    logger: counter,
  }).initialize();

  try {
    const total = await ds.getRepository(Order).count();
    if (total === 0) {
      console.error('✖ У базі немає замовлень. Спершу: npm run migrate && npm run seed');
      process.exit(1);
    }

    // Половина колекції і вся колекція: якщо «після» не залежить від N,
    // число не зміниться, а «до» — зросте разом із N.
    const sizes = [Math.max(1, Math.floor(total / 2)), total];

    console.log('Граф: order → items → product (два рівні звʼязків)');
    console.log(`Усього замовлень у базі: ${total}\n`);

    // Спершу показуємо сам лог SQL — без нього N+1 у коді не видно.
    counter.start();
    await naiveLogSample(ds);
    const sample = counter.stop();
    console.log(`── Лог SQL наївного варіанта для перших 2 замовлень (${sample.length} запитів) ──`);
    for (const [i, sql] of sample.entries()) console.log(`  ${String(i + 1).padStart(2)}. ${short(sql)}`);
    console.log();

    const rows: Array<Record<string, string | number>> = [];
    for (const take of sizes) {
      const results = [
        await naive(ds, take),
        await withRelations(ds, take),
        await withJoinAndSelect(ds, take),
        await withQueryStrategy(ds, take),
      ];
      for (const r of results) {
        rows.push({
          'N (замовлень)': take,
          Стратегія: r.strategy,
          'SQL-запитів': r.queries,
          'позицій зібрано': r.items,
        });
      }
    }

    const noTake = await withRelationsNoTake(ds);
    rows.push({
      'N (замовлень)': noTake.orders,
      Стратегія: noTake.strategy,
      'SQL-запитів': noTake.queries,
      'позицій зібрано': noTake.items,
    });

    console.log('── Кількість SQL-запитів ──');
    console.table(rows);

    const naiveSmall = rows.find((r) => r['N (замовлень)'] === sizes[0] && r['Стратегія'] === 'наївно (запит у циклі)');
    const naiveBig = rows.find((r) => r['N (замовлень)'] === sizes[1] && r['Стратегія'] === 'наївно (запит у циклі)');
    const joinSmall = rows.find((r) => r['N (замовлень)'] === sizes[0] && r['Стратегія'] === 'relations (join)');
    const joinBig = rows.find((r) => r['N (замовлень)'] === sizes[1] && r['Стратегія'] === 'relations (join)');

    console.log(
      [
        `Наївно:            N=${sizes[0]} → ${naiveSmall?.['SQL-запитів']} запитів,  N=${sizes[1]} → ${naiveBig?.['SQL-запитів']} запитів  (росте разом із N)`,
        `relations (join):  N=${sizes[0]} → ${joinSmall?.['SQL-запитів']} запити,   N=${sizes[1]} → ${joinBig?.['SQL-запитів']} запити    (константа)`,
        `  з них один — вибір N різних id кореня; без пагінації той самий граф тягнеться за ${noTake.queries} запит.`,
      ].join('\n'),
    );
  } finally {
    await ds.destroy();
  }
}

/** Окремий крихітний прогін лише заради читабельного логу. */
async function naiveLogSample(ds: DataSource): Promise<void> {
  const orders = await ds.getRepository(Order).find({ order: { id: 'ASC' }, take: 2 });
  for (const order of orders) {
    const items = await ds.getRepository(OrderItem).find({ where: { orderId: order.id } });
    for (const item of items) {
      await ds.getRepository(Product).findOne({ where: { id: item.productId } });
    }
  }
}

main().catch((error: unknown) => {
  console.error('\n✖ demo:nplus1 не відпрацював.\n');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
