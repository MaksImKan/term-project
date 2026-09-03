import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../db/database.service';
import { Env } from '../config/env.schema';

const STARTED_AT = new Date().toISOString();

/**
 * /health свідомо віддає uptime процесу: саме за ним у критерії приймання
 * видно, що після ротації пароля сервіс НЕ перезапускався.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Get()
  async health() {
    let db: 'ok' | 'down' = 'down';
    try {
      db = (await this.db.ping()) ? 'ok' : 'down';
    } catch {
      db = 'down';
    }

    return {
      status: db === 'ok' ? 'ok' : 'degraded',
      env: this.config.get('NODE_ENV', { infer: true }),
      pid: process.pid,
      started_at: STARTED_AT,
      uptime_seconds: Math.round(process.uptime() * 1000) / 1000,
      db,
      pool: this.db.poolStats(),
    };
  }
}
