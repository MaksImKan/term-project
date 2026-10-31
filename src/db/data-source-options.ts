import { DataSourceOptions } from 'typeorm';
import { Order, OrderItem, PickingTask, Product, Task, User } from '../entities';
import { migrations } from '../migrations';

/**
 * Параметри підключення — і НІЧОГО, що виконується на імпорті.
 *
 * Чому це окремий файл, а не частина data-source.ts: той завершується рядком
 * `export const AppDataSource = new DataSource(buildOptions())`, тобто читає
 * оточення в момент ІМПОРТУ. Поки DatabaseService імпортував buildOptions
 * звідти, будь-який імпорт AppModule тягнув за собою цю перевірку — і голий
 * `npm run start` без секретів падав зі словами «Не задано змінну DB_HOST»
 * ще до того, як відпрацьовувала zod-схема застосунку. Тобто процес помирав,
 * не назвавши тієї змінної, якої насправді бракує (ДЗ-24, критерій 3).
 *
 * Тепер eager-інстанс лишився тільки там, де він і потрібен, — у точці входу
 * TypeORM CLI, а застосунок валідує конфіг ПЕРШОЮ дією.
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
  entities: [User, Product, Order, OrderItem, Task, PickingTask],
  migrations,
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
