#!/usr/bin/env node
/**
 * check:env — звірка .env.example із zod-схемою src/config/env.schema.ts.
 *
 * Навіщо: .env.example є контрактом для нового розробника й для CI. Варто
 * додати змінну у схему й забути про приклад — і людина дізнається про це
 * лише тоді, коли впаде старт. Скрипт ловить розсинхрон у CI, exit 1.
 *
 * Перевіряє три речі:
 *   1) кожен ключ схеми присутній у .env.example;
 *   2) у .env.example немає ключів, яких схема не знає;
 *   3) кожен ключ у прикладі має коментар-пояснення прямо над собою.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_FILE = resolve(ROOT, 'src/config/env.schema.ts');
const EXAMPLE_FILE = resolve(ROOT, '.env.example');

const read = (file, label) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    console.error(`✖ ${label} не знайдено: ${file}`);
    process.exit(1);
  }
};

/** Ключі zod-схеми: беремо блок z.object({ ... }) і читаємо ключі верхнього рівня. */
function schemaKeys(source) {
  const start = source.indexOf('z.object({');
  if (start === -1) {
    console.error('✖ У env.schema.ts не знайдено блок z.object({ ... }).');
    process.exit(1);
  }
  const block = source.slice(start, source.indexOf('\n});', start));
  const keys = [...block.matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]);
  if (keys.length === 0) {
    console.error('✖ У схемі не знайдено жодної змінної.');
    process.exit(1);
  }
  return keys;
}

/** Ключі .env.example + чи є коментар безпосередньо над кожним. */
function exampleKeys(source) {
  const lines = source.split('\n');
  const keys = [];
  const undocumented = [];

  lines.forEach((line, index) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (!match) return;
    keys.push(match[1]);

    const previous = (lines[index - 1] ?? '').trim();
    if (!previous.startsWith('#')) undocumented.push(match[1]);
  });

  return { keys, undocumented };
}

const expected = schemaKeys(read(SCHEMA_FILE, 'Схема'));
const { keys: actual, undocumented } = exampleKeys(read(EXAMPLE_FILE, '.env.example'));

const missing = expected.filter((key) => !actual.includes(key));
const extra = actual.filter((key) => !expected.includes(key));
const duplicates = actual.filter((key, i) => actual.indexOf(key) !== i);

const problems = [];
if (missing.length) problems.push(`відсутні у .env.example: ${missing.join(', ')}`);
if (extra.length) problems.push(`зайві у .env.example (немає у схемі): ${extra.join(', ')}`);
if (duplicates.length) problems.push(`продубльовані у .env.example: ${[...new Set(duplicates)].join(', ')}`);
if (undocumented.length) problems.push(`без коментаря-пояснення: ${undocumented.join(', ')}`);

if (problems.length) {
  console.error('✖ .env.example розсинхронізований зі схемою:');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('\nВиправ .env.example і повтори: npm run check:env');
  process.exit(1);
}

console.log(`✔ .env.example синхронний зі схемою (${expected.length} змінних).`);
