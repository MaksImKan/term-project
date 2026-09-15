import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseService } from './database.service';

/**
 * Глобальний модуль доступу до Postgres.
 * Пул створюється один раз на процес; пароль пул перечитує з файла
 * САМОСТІЙНО на кожне нове зʼєднання (див. DatabaseService).
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
