import 'reflect-metadata';
import { AppDataSource } from './data-source';
import { OrderItem } from './entities';

/**
 * Звіт «виторг по продавцях» — приклад запиту, який через find() не виражається.
 *
 *   npm run report
 *
 * Чому не Repository: find() вміє повертати СУТНОСТІ та їхні звʼязки. Тут
 * результат — не сутність: три JOIN-и згортаються в один рядок на продавця з
 * агрегатами, яких у жодній таблиці немає. Це форма звіту, а не форма домену,
 * тож getRawMany() і чесний SQL.
 */
async function main(): Promise<void> {
  const ds = await AppDataSource.initialize();

  try {
    const rows = await ds
      .getRepository(OrderItem)
      .createQueryBuilder('oi')
      .innerJoin('oi.order', 'o')
      .innerJoin('oi.product', 'p')
      .innerJoin('p.seller', 's')
      .select('s.id', 'seller_id')
      .addSelect('s.full_name', 'seller_name')
      .addSelect('s.city', 'city')
      .addSelect('COUNT(DISTINCT o.id)', 'orders_count')
      .addSelect('SUM(oi.quantity)', 'units_sold')
      .addSelect('SUM(oi.quantity * oi.unit_price_cents)', 'revenue_cents')
      // Виторг рахуємо лише за грошима, які реально прийшли: скасовані й
      // неоплачені замовлення у звіт не потрапляють.
      .where('o.status IN (:...statuses)', {
        statuses: ['paid', 'shipped', 'delivered'],
      })
      .groupBy('s.id')
      .addGroupBy('s.full_name')
      .addGroupBy('s.city')
      .orderBy('revenue_cents', 'DESC')
      .addOrderBy('s.id', 'ASC')
      .limit(10)
      .getRawMany<{
        seller_id: string;
        seller_name: string;
        city: string;
        orders_count: string;
        units_sold: string;
        revenue_cents: string;
      }>();

    if (rows.length === 0) {
      console.error('✖ Порожній звіт. Спершу: npm run migrate && npm run seed');
      process.exit(1);
    }

    console.log('Виторг по продавцях (оплачені, відправлені та доставлені замовлення)\n');

    // COUNT/SUM приходять РЯДКАМИ: у Postgres вони bigint/numeric, а bigint у
    // number може не влізти, тож драйвер свідомо не конвертує. Приводимо самі.
    console.table(
      rows.map((r) => ({
        'id': r.seller_id,
        'Продавець': r.seller_name,
        'Місто': r.city,
        'Замовлень': Number(r.orders_count),
        'Одиниць': Number(r.units_sold),
        'Виторг, грн': (Number(r.revenue_cents) / 100).toFixed(2),
      })),
    );

    const total = rows.reduce((sum, r) => sum + Number(r.revenue_cents), 0);
    console.log(`Разом: ${(total / 100).toFixed(2)} грн`);
  } finally {
    await ds.destroy();
  }
}

main().catch((error: unknown) => {
  console.error('\n✖ report не відпрацював.\n');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
