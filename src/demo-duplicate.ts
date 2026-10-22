import 'reflect-metadata';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { checkout } from './checkout';
import { assertSeeded, openDataSource, resetDemoState } from './demo-support';
import { brokerPrefetch, report, resetDemo, waitFor } from './messaging/demo-support';
import { startConsumer } from './messaging/consumer';
import { countAppliedEffects } from './messaging/effect';
import { OrderEventPublisher } from './messaging/publisher';
import { DLQ, QUEUE, assertTopology, openConnection, queueDepth } from './messaging/topology';
import { PRODUCTS, USERS } from './seed';

/**
 * demo:duplicate — доставок дві, ефект один.
 *
 *   bash scripts/with-secrets.sh dev node dist/demo-duplicate.js
 *
 * Як викликається повтор: окремий процес-споживач (dist/crash-consumer.js)
 * застосовує ефект і вбиває себе SIGKILL-ом ДО ack. Брокер бачить обрив
 * зʼєднання, вважає повідомлення непідтвердженим і повертає його в чергу —
 * це і є at-least-once у чистому вигляді. Другий, уже нормальний споживач
 * отримує ту саму подію вдруге.
 *
 * Чому саме kill, а не channel.close(): close — коректне завершення, і
 * requeue там теж станеться, але падіння сервісу в проді виглядає інакше.
 * Форма повтору тут обрана навмисно найближча до реальності.
 *
 * Інваріант: deliveries ≥ 2 і при цьому effect = 1. Якби deliveries дорівнював
 * одиниці, демо не довело б нічого: дубля просто не було б.
 */
const PRODUCT_ID = PRODUCTS[0].id!;
const CRASH_CONSUMER = path.join(__dirname, 'crash-consumer.js');

interface ChildOutcome {
  deliveries: number;
  effect: number;
  crashed: boolean;
}

/** Піднімає процес-споживач і чекає, поки той дійде до падіння. */
function runCrashConsumer(onReady: () => Promise<void>): Promise<ChildOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CRASH_CONSUMER], {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: process.env,
    });

    const outcome: ChildOutcome = { deliveries: 0, effect: 0, crashed: false };
    let buffer = '';
    let readyFired = false;

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.length > 0) console.log(`[crash-consumer] ${line}`);

        if (line === 'CHILD_READY' && !readyFired) {
          readyFired = true;
          onReady().catch(reject);
        }
        if (line.startsWith('CHILD_DELIVERIES=')) {
          outcome.deliveries = Number(line.split('=')[1]);
        }
        if (line.startsWith('CHILD_EFFECT=')) outcome.effect = Number(line.split('=')[1]);
        if (line === 'CHILD_CRASH') outcome.crashed = true;
        if (line.startsWith('CHILD_ERROR=')) reject(new Error(line));
      }
    });

    child.on('exit', (code, signal) => {
      // Очікуваний вихід — саме від сигналу: це не збій демо, а його суть.
      if (signal === 'SIGKILL' || outcome.crashed) resolve(outcome);
      else reject(new Error(`процес-споживач завершився сам: code=${code} signal=${signal}`));
    });
    child.on('error', reject);
  });
}

async function main(): Promise<never> {
  const prefetch = brokerPrefetch();
  const dataSource = await openDataSource(10);
  const connection = await openConnection();

  try {
    await assertSeeded(dataSource);

    const setup = await connection.createChannel();
    await assertTopology(setup);
    await resetDemo(setup, dataSource);
    await resetDemoState(dataSource, { stock: 5, productId: PRODUCT_ID });

    const publisher = await OrderEventPublisher.open(connection);

    // Одне замовлення — одна подія. Публікуємо лише коли дочірній споживач
    // уже підписаний.
    const child = await runCrashConsumer(async () => {
      await checkout(
        dataSource,
        { buyerId: USERS[0].id!, productId: PRODUCT_ID, quantity: 1 },
        publisher,
      );
    });

    if (!child.crashed) throw new Error('дочірній споживач не впав — повтору не буде');

    // Другий споживач: нормальний, із тим самим ідемпотентним ефектом.
    const consumer = await startConsumer(connection, { dataSource, prefetch });
    await waitFor(() => consumer.stats.deliveries >= 1, 30_000);

    // Чекаємо, поки ack дійде і черга спорожніє — опитуванням, не сном.
    let work = await queueDepth(setup, QUEUE);
    for (let attempt = 0; attempt < 50 && work > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      work = await queueDepth(setup, QUEUE);
    }

    const deliveries = child.deliveries + consumer.stats.deliveries;
    const effect = await countAppliedEffects(dataSource);
    const skipped = consumer.stats.skipped;
    const dlq = await queueDepth(setup, DLQ);

    await publisher.close();
    await consumer.stop();
    await setup.close();
    await connection.close();
    await dataSource.destroy();

    return report(
      { deliveries, effect, skipped, work, dlq, prefetch },
      [
        { what: 'доставок було щонайменше дві (повтор справді стався)', ok: deliveries >= 2 },
        { what: 'ефект застосовано рівно один раз', ok: effect === 1 },
        { what: 'повтор розпізнано як дубль', ok: skipped >= 1 },
        { what: 'робоча черга розібрана', ok: work === 0 },
        { what: 'у DLQ нічого не поїхало', ok: dlq === 0 },
      ],
    );
  } catch (error) {
    await dataSource.destroy().catch(() => undefined);
    await connection.close().catch(() => undefined);
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
