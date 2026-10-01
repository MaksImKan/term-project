import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { NEST_APP_OPTIONS, configureApp } from './bootstrap';
import { Env } from './config/env.schema';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, NEST_APP_OPTIONS);

  // Те саме налаштування, що застосовують e2e-тести й provider-верифікація:
  // порядок middleware, валідація проти openapi.yaml, problem+json, shutdown
  // hooks. Один виклик — одна правда про те, як зібраний застосунок.
  configureApp(app);

  // Єдина точка доступу до конфігурації: типізований ConfigService.
  // Прямих читань process.env поза zod-схемою у коді немає.
  const config = app.get(ConfigService) as ConfigService<Env, true>;

  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(
    `Marketplace API (${config.get('NODE_ENV', { infer: true })}) на http://localhost:${port}`,
  );
}

// Fail-fast: будь-яка помилка старту (насамперед — провал валідації env)
// друкує зрозумілу причину й завершує процес НЕнульовим кодом.
bootstrap().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('\n✖ Застосунок не стартував.\n');
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
