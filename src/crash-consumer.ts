import 'reflect-metadata';
import { writeSync } from 'node:fs';
import { openDataSource } from './demo-support';
import { brokerPrefetch } from './messaging/demo-support';
import { startConsumer } from './messaging/consumer';
import { openConnection } from './messaging/topology';

/**
 * Споживач, який навмисно падає між ефектом і ack (ДЗ-19).
 *
 * Запускається demo:duplicate окремим ПРОЦЕСОМ — і це принципово.
 * `channel.close()` не підходить: це коректне завершення, брокер при ньому
 * теж поверне непідтверджене в чергу, але в проді о 3-й ночі сервіс зникає
 * інакше — процес перестає існувати, ОС закриває сокет, брокер бачить обрив.
 * Саме це тут і відтворюється через SIGKILL самому собі: жодних обробників
 * виходу, жодного шансу надіслати ack.
 *
 * Батьківському процесу все повідомляється рядками в stdout, записаними
 * СИНХРОННО: після SIGKILL черга подій Node не виконається, тож звичайний
 * console.log міг би не долетіти.
 */
function emit(line: string): void {
  writeSync(1, `${line}\n`);
}

async function main(): Promise<void> {
  const dataSource = await openDataSource(5);
  const connection = await openConnection();

  const consumer = await startConsumer(connection, {
    dataSource,
    prefetch: brokerPrefetch(),
    afterEffect: (event, stats) => {
      emit(`CHILD_DELIVERIES=${stats.deliveries}`);
      emit(`CHILD_EFFECT=${stats.applied}`);
      emit(`CHILD_EVENT=${event.eventId}`);
      emit('CHILD_CRASH');
      // Ефект уже в базі, ack ще не надіслано — рівно та щілина, через яку
      // at-least-once доставка дає повторну доставку.
      process.kill(process.pid, 'SIGKILL');
    },
  });

  // Сигнал батькові: тепер можна публікувати. Якщо опублікувати раніше,
  // повідомлення просто полежить у черзі — демо від цього не зламається, але
  // стане повільнішим без причини.
  emit('CHILD_READY');

  // Процес тримається підпискою; вихід звідси лише через SIGKILL вище.
  void consumer;
}

main().catch((error: unknown) => {
  emit(`CHILD_ERROR=${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
