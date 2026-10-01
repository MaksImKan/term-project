/**
 * Базова конфігурація Jest для всіх наборів тестів.
 *
 * reporters: ['default'] — не косметика. Jest 30 без цього рядка вибирає
 * репортер САМ, за змінними оточення (detectAgent() у @jest/core), і в частині
 * середовищ вмикає компактний `agent`-репортер: той не друкує ані `PASS <файл>`,
 * ані назв describe/it, ані ✓ — лишається тільки `Tests: N passed`. У своєму
 * терміналі різниці не видно, але невідомо, звідки запустять цю роботу, тож
 * репортер фіксуємо явно.
 *
 * maxWorkers: 1 — кожен воркер jest множить контейнери testcontainers. Один
 * воркер означає один Postgres на прогін.
 *
 * ts-jest, а не esbuild/swc: ті не емітять decorator-метадані, без яких
 * TypeORM-ентіті й Nest-DI просто не працюють.
 */
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  reporters: ['default'],
  maxWorkers: 1,
  testTimeout: 180000,
  moduleFileExtensions: ['ts', 'js', 'json'],
  // І *.spec.ts, і Nest-конвенція *.e2e-spec.ts.
  testMatch: ['<rootDir>/test/**/*.spec.ts', '<rootDir>/test/**/*-spec.ts'],
  // Контейнер піднімається один раз на файл, тому форсований вихід не потрібен:
  // усі пули і застосунки закриваються в afterAll. Якщо jest колись «зависне» —
  // це баг у тестах, і шукати його треба через --detectOpenHandles.
  forceExit: false,
};
