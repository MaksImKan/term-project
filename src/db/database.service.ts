import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, QueryResultRow } from 'pg';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Env } from '../config/env.schema';

/**
 * Пароль БД НЕ живе в env і НЕ читається один раз на старті.
 * pg приймає у полі password функцію (у т.ч. async) і викликає її
 * на КОЖНЕ нове зʼєднання — це і є «перечитати секрет».
 * Саме тому ротація не потребує рестарту процесу.
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly pool: Pool;
  private readonly passwordFile: string;

  constructor(private readonly config: ConfigService<Env, true>) {
    const dsn = new URL(this.config.get('DB_URL', { infer: true }));
    const useSsl = this.config.get('DB_SSL', { infer: true });

    const rawPasswordFile = this.config.get('DB_PASSWORD_FILE', { infer: true });
    this.passwordFile = path.isAbsolute(rawPasswordFile)
      ? rawPasswordFile
      : path.resolve(process.cwd(), rawPasswordFile);

    this.pool = new Pool({
      host: dsn.hostname,
      port: dsn.port ? Number(dsn.port) : 5432,
      user: decodeURIComponent(dsn.username),
      database: decodeURIComponent(dsn.pathname.replace(/^\//, '')),
      max: this.config.get('DB_POOL_MAX', { infer: true }),
      connectionTimeoutMillis: this.config.get('DB_CONNECTION_TIMEOUT_MS', { infer: true }),
      ssl: useSsl ? { rejectUnauthorized: false } : undefined,

      // ← ключовий рядок усього ДЗ: пароль як функція, а не як рядок.
      password: () => this.readPassword(),
    });

    // Після pg_terminate_backend Postgres рве простій-зʼєднання, і пул емітить
    // 'error'. Без цього обробника unhandled 'error' ПОКЛАДЕ процес —
    // і ротація виглядатиме як падіння сервісу. Це не баг ротації.
    this.pool.on('error', (err) => {
      this.logger.warn(`idle client error (очікувано під час ротації): ${err.message}`);
    });
  }

  /** Читає секрет з файла. Викликається pg на кожне нове зʼєднання. */
  private async readPassword(): Promise<string> {
    try {
      const value = await readFile(this.passwordFile, 'utf8');
      return value.trim();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Не вдалося прочитати пароль БД з файла-секрета "${this.passwordFile}": ${reason}. ` +
          'Створи його командою `npm run secrets:init`.',
      );
    }
  }

  async onModuleInit(): Promise<void> {
    // Перше зʼєднання робимо на старті, щоб зламаний секрет був видно одразу.
    try {
      await this.ping();
      this.logger.log('зʼєднання з Postgres встановлено (пароль прочитано з файла-секрета)');
    } catch (err) {
      this.logger.error(
        `Postgres недоступний на старті: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end().catch(() => undefined);
  }

  async query<T extends QueryResultRow>(text: string, params: unknown[] = []) {
    return this.pool.query<T>(text, params);
  }

  /** Легкий health-запит: примусово бере зʼєднання з пулу. */
  async ping(): Promise<boolean> {
    const { rows } = await this.pool.query<{ ok: number }>('SELECT 1 AS ok');
    return rows[0]?.ok === 1;
  }

  /** Скільки зʼєднань зараз тримає пул (видно, що після ротації вони нові). */
  poolStats(): { total: number; idle: number; waiting: number } {
    return { total: this.pool.totalCount, idle: this.pool.idleCount, waiting: this.pool.waitingCount };
  }
}
