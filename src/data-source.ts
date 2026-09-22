import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import { Order, OrderItem, Product, User } from './entities';

/**
 * DataSource для TypeORM CLI (міграції) і для скриптів seed / demo / report.
 *
 * Тут НЕМАЄ ані зашитого хоста з паролем, ані читання власного env-файла:
 * усі значення приходять із process.env, який наповнює обгортка сховища
 * `scripts/with-secrets.sh` (Infisical, ДЗ-11). Локально — `infisical run`,
 * у CI та в грейдера — `SKIP_VAULT=1` і значення вже в оточенні.
 *
 * Чому окрема перевірка, а не zod-схема застосунку з ДЗ-11: та схема вимагає
 * DB_URL і виконується всередині Nest, а CLI міграцій живе поза DI-графом і
 * має вміти обидві форми підключення — і єдиний DB_URL, і розібрані DB_*.
 */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      [
        `Не задано змінну ${name}.`,
        '',
        'Підключення до БД приходить зі сховища:',
        '  bash scripts/with-secrets.sh dev npm run migrate',
        '',
        'Без доступу до сховища (CI, грейдер) — значення в оточенні:',
        '  export DB_HOST=127.0.0.1 DB_PORT=5432 DB_USER=marketplace \\',
        '         DB_PASSWORD=dev_password_0 DB_NAME=marketplace',
        '  export SKIP_VAULT=1',
      ].join('\n'),
    );
  }
  return value;
}

const shared = {
  type: 'postgres',
  // Схема НІКОЛИ не синхронізується автоматично: єдиний спосіб змінити
  // структуру — міграція, яку видно в code review і яку можна відкотити.
  synchronize: false,
  logging: false,
  entities: [User, Product, Order, OrderItem],
  migrations: [__dirname + '/migrations/*.{js,ts}'],
} satisfies Partial<DataSourceOptions>;

export function buildOptions(): DataSourceOptions {
  // Єдиний DSN має пріоритет: саме його віддає сховище застосунку (ДЗ-11).
  const url = process.env.DB_URL ?? process.env.DATABASE_URL;
  if (url) return { ...shared, url } as DataSourceOptions;

  return {
    ...shared,
    host: required('DB_HOST'),
    port: Number(process.env.DB_PORT ?? 5432),
    // pg чекає `user`, TypeORM — `username`. Переплутати їх означає
    // «password authentication failed» при цілком правильному паролі.
    username: required('DB_USER'),
    password: required('DB_PASSWORD'),
    database: required('DB_NAME'),
  } as DataSourceOptions;
}

/**
 * Рівно ОДИН експорт DataSource у файлі: TypeORM CLI відмовляється працювати,
 * якщо їх кілька («Given data source file must contain only one export of
 * DataSource instance») — тому ані `export default`, ані аліасів тут немає.
 */
export const AppDataSource = new DataSource(buildOptions());
