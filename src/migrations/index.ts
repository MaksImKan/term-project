import { InitialSchema1790103845758 } from './1790103845758-InitialSchema';
import { ConcurrencyQueue1790370772509 } from './1790370772509-ConcurrencyQueue';

/**
 * Список міграцій у порядку застосування — ЯВНО, без glob-а.
 *
 * Чому не `__dirname + '/migrations/*.{js,ts}'`: під ts-jest (integration- та
 * e2e-тести підіймають схему з коду) TypeORM вантажив би .ts-файли своїм
 * require поза реєстром модулів jest, і це працює через раз. Явний масив
 * однаково коректний і для CLI (dist/*.js), і для тестів.
 *
 * Додав міграцію через `npm run migration:generate` — допиши її сюди.
 */
export const migrations = [InitialSchema1790103845758, ConcurrencyQueue1790370772509];
