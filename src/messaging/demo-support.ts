import type { DataSource } from 'typeorm';
import { envSchema } from '../config/env.schema';
import { resetEffects } from './effect';
import { purgeAll } from './topology';
import type { Channel } from 'amqplib';

/**
 * Спільна частина трьох демо ДЗ-19.
 *
 * Кожне демо зобовʼязане (1) само привести стан до чистого, (2) надрукувати
 * підсумок рядками ключ=значення і (3) само перевірити інваріант. Третю
 * частину робить `report()`: вона ж і визначає код виходу, тож «демо впало»
 * і «інваріант порушено» — це одне й те саме.
 */

/** prefetch береться з тієї самої конфігурації, що й решта налаштувань. */
export function brokerPrefetch(): number {
  return envSchema.shape.BROKER_PREFETCH.parse(process.env.BROKER_PREFETCH);
}

/** Чистий аркуш: порожні черги плюс прибрані ефекти минулих прогонів. */
export async function resetDemo(channel: Channel, dataSource: DataSource): Promise<void> {
  await purgeAll(channel);
  await resetEffects(dataSource);
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Чекає на умову до дедлайну. Повертає true, якщо дочекались.
 *
 * Фіксований sleep тут не годиться: він або довгий, або мерехтливий.
 */
export async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  stepMs = 25,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(stepMs);
  }
  return condition();
}

export interface Invariant {
  /** Людський опис того, що саме перевіряємо. */
  what: string;
  ok: boolean;
}

/**
 * Друкує контракт виводу (ключ=значення) і перевіряє інваріанти.
 *
 * Значення друкуються ПЕРШИМИ і завжди — навіть коли інваріант порушено:
 * грейдер (і людина) мають побачити фактичні числа, а не лише «впало».
 */
export function report(values: Record<string, string | number>, invariants: Invariant[]): never {
  for (const [key, value] of Object.entries(values)) {
    console.log(`${key}=${value}`);
  }

  const broken = invariants.filter((invariant) => !invariant.ok);
  if (broken.length === 0) {
    console.log(`\n✔ інваріант витримано: ${invariants.map((i) => i.what).join('; ')}`);
    process.exit(0);
  }

  console.error('\n✖ інваріант порушено:');
  for (const invariant of broken) console.error(`  — ${invariant.what}`);
  process.exit(1);
}
