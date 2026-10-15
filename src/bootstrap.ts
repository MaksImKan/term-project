import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import * as path from 'path';
import { Env } from './config/env.schema';
import { ProblemJsonFilter } from './problem/problem.filter';

/**
 * Налаштування застосунку, спільне для прода і тестів.
 *
 * Чому окрема функція, а не код усередині main.ts: e2e-тест (test/e2e/) і
 * provider-верифікація Pact (test/contract/) підіймають застосунок самі, через
 * Test.createTestingModule. Якби порядок middleware і глобальні фільтри жили
 * лише в main.ts, тести перевіряли б ІНШИЙ застосунок, ніж той, що йде в прод:
 * без express-openapi-validator не було б ані 400 на зламаному запиті, ані
 * problem+json у відповіді. Тобто найцінніші негативні кейси не ловилися б.
 */
export function configureApp(app: NestExpressApplication): NestExpressApplication {
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

  return app;
}

/**
 * bodyParser: false — самі ставимо express.json() ПЕРЕД валідатором, щоб
 * гарантувати порядок middleware: json -> validator -> роути.
 */
export const NEST_APP_OPTIONS = { bodyParser: false } as const;
