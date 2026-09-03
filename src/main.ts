import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import express from 'express';
import * as path from 'path';
import * as OpenApiValidator from 'express-openapi-validator';
import { AppModule } from './app.module';
import { ProblemJsonFilter } from './problem/problem.filter';
import { Env } from './config/env.schema';

async function bootstrap(): Promise<void> {
  // bodyParser: false — самі ставимо express.json() ПЕРЕД валідатором,
  // щоб гарантувати порядок middleware: json -> validator -> роути.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  // Єдина точка доступу до конфігурації: типізований ConfigService.
  // Прямих читань process.env поза zod-схемою у коді немає.
  const config = app.get(ConfigService) as ConfigService<Env, true>;

  const instance = app.getHttpAdapter().getInstance();

  // 1) парсинг тіла
  instance.use(express.json());

  // 2) express-openapi-validator: валідація ЗАПИТІВ і ВІДПОВІДЕЙ проти спеки
  instance.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'openapi', 'openapi.yaml'),
      validateRequests: true,
      validateResponses: config.get('VALIDATE_RESPONSES', { infer: true }),
    }),
  );

  // помилки, кинуті у Nest-контексті (404/422 із сервісів) -> problem+json
  app.useGlobalFilters(new ProblemJsonFilter());

  // щоб onApplicationShutdown закрив пул Postgres
  app.enableShutdownHooks();

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
