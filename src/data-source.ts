import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { buildOptions } from './db/data-source-options';

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
export { buildOptions } from './db/data-source-options';

/**
 * Рівно ОДИН експорт DataSource у файлі: TypeORM CLI відмовляється працювати,
 * якщо їх кілька («Given data source file must contain only one export of
 * DataSource instance») — тому ані `export default`, ані аліасів тут немає.
 */
export const AppDataSource = new DataSource(buildOptions());
