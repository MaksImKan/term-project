import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import * as path from 'path';
import * as OpenApiValidator from 'express-openapi-validator';
import { AppModule } from './app.module';
import { ProblemJsonFilter } from './problem/problem.filter';

async function bootstrap(): Promise<void> {
  // bodyParser: false — самі ставимо express.json() ПЕРЕД валідатором,
  // щоб гарантувати порядок middleware: json -> validator -> роути.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  const instance = app.getHttpAdapter().getInstance();

  // 1) парсинг тіла
  instance.use(express.json());

  // 2) express-openapi-validator: валідація ЗАПИТІВ і ВІДПОВІДЕЙ проти спеки
  instance.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'openapi', 'openapi.yaml'),
      validateRequests: true,
      validateResponses: true, // саме це відхиляє відповідь, що суперечить спеці
    }),
  );

  // помилки, кинуті у Nest-контексті (404/422 із сервісів) -> problem+json
  app.useGlobalFilters(new ProblemJsonFilter());

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Marketplace API (Variant Б, NestJS) на http://localhost:${port}`);
}

void bootstrap();
