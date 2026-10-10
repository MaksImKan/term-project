#!/usr/bin/env node
/**
 * Headless-демо ізоляції WebSocket-кімнат.
 *
 *   node scripts/realtime-demo.mjs               # клієнти в РІЗНИХ кімнатах -> B_RECEIVED=0
 *   node scripts/realtime-demo.mjs --same-room   # обидва в кімнаті A       -> B_RECEIVED=1
 *
 * Обидва прогони йдуть ОДНИМ І ТИМ САМИМ кодом: прапорець міняє лише кімнату
 * другого клієнта і, звідти ж, очікуване значення B_RECEIVED. У цьому й сенс
 * контрольного режиму: скрипт, який просто друкує «B_RECEIVED=0», на ньому
 * себе викриє, бо очікування стане протилежним, а вивід — ні.
 *
 * Що вимірюється: чи дійшла подія зміни статусу замовлення A до сокета, який
 * сидить у кімнаті замовлення B. Нічого не припускаємо наперед — слухаємо
 * справжній сокет і дивимось, що прийшло.
 *
 * Код виходу: 0 — реальність збіглася з очікуванням, 1 — ні.
 *
 * Змінні оточення: API_URL (типово http://localhost:3000), ORDER_A, ORDER_B,
 * DEMO_USER — на випадок, якщо сід замовлень інший.
 */
import { io } from 'socket.io-client';

const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const ORDER_A = process.env.ORDER_A ?? 'o_1';
const ORDER_B = process.env.ORDER_B ?? 'o_2';
const USER = process.env.DEMO_USER ?? 'u_1';

const SAME_ROOM = process.argv.includes('--same-room');

/** Єдине місце, де прапорець щось вирішує. */
const ROOM_FOR_B = SAME_ROOM ? ORDER_A : ORDER_B;
const EXPECTED_B = SAME_ROOM ? 1 : 0;

/** Скільки чекаємо на подію після зміни статусу. */
const SETTLE_MS = Number(process.env.DEMO_SETTLE_MS ?? 1200);
const ACK_TIMEOUT_MS = 5000;

const log = (...parts) => console.log('[demo]', ...parts);

function connect(userId) {
  const socket = io(API_URL, {
    auth: userId ? { userId } : {},
    transports: ['websocket'],
    reconnection: false,
    timeout: ACK_TIMEOUT_MS,
  });

  // Події реконекту живуть на manager-і, не на сокеті — тут лише для видимості
  // в логах, бо reconnection вимкнено навмисно: демо має падати, а не «лікувати»
  // проблему мовчазними перепідключеннями.
  socket.io.on('reconnect_attempt', (n) => log(`reconnect_attempt #${n}`));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`не вдалося підключитися до ${API_URL} за ${ACK_TIMEOUT_MS} мс`)),
      ACK_TIMEOUT_MS,
    );
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', (error) => {
      clearTimeout(timer);
      reject(new Error(`connect_error: ${error.message}`));
    });
  });
}

/** join з ack. Без ack не можна рухатися далі: подія вилетить повз кімнату. */
function join(socket, orderId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`join ${orderId}: немає ack`)), ACK_TIMEOUT_MS);
    socket.emit('join', { orderId }, (ack) => {
      clearTimeout(timer);
      resolve(ack ?? { ok: false, error: 'empty_ack' });
    });
  });
}

/** Лічильник подій order.status, що долетіли до цього сокета. */
function countEvents(socket) {
  const received = [];
  socket.on('order.status', (event) => received.push(event));
  return received;
}

async function patchStatus(orderId, status) {
  const response = await fetch(`${API_URL}/orders/${orderId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!response.ok) {
    throw new Error(`PATCH /orders/${orderId}/status -> ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function currentStatus(orderId) {
  const response = await fetch(`${API_URL}/orders/${orderId}`);
  if (!response.ok) throw new Error(`GET /orders/${orderId} -> ${response.status}`);
  return (await response.json()).status;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  log(`режим: ${SAME_ROOM ? '--same-room (контрольний)' : 'основний'}`);
  log(`клієнт A -> кімната замовлення ${ORDER_A}`);
  log(`клієнт B -> кімната замовлення ${ROOM_FOR_B}`);

  const failures = [];
  const sockets = [];

  try {
    // 1. Підключення.
    const clientA = await connect(USER);
    const clientB = await connect(USER);
    sockets.push(clientA, clientB);

    // 2. join + ack. Тільки після ack сокет справді в кімнаті.
    const ackA = await join(clientA, ORDER_A);
    const ackB = await join(clientB, ROOM_FOR_B);
    log(`ack A: ${JSON.stringify(ackA)}`);
    log(`ack B: ${JSON.stringify(ackB)}`);
    if (!ackA.ok) failures.push(`клієнт A не потрапив у кімнату: ${ackA.error}`);
    if (!ackB.ok) failures.push(`клієнт B не потрапив у кімнату: ${ackB.error}`);

    // 3. Слухаємо ПІСЛЯ join, але ДО зміни статусу.
    const receivedA = countEvents(clientA);
    const receivedB = countEvents(clientB);

    // 4. Міняємо статус замовлення A на інший, ніж поточний, — щоб подія була
    //    справжньою зміною, а не повтором.
    const before = await currentStatus(ORDER_A);
    const next = before === 'paid' ? 'cancelled' : 'paid';
    log(`PATCH /orders/${ORDER_A}/status: ${before} -> ${next}`);
    await patchStatus(ORDER_A, next);

    // 5. Даємо події долетіти.
    await sleep(SETTLE_MS);

    const aReceived = receivedA.length > 0 ? 1 : 0;
    const bReceived = receivedB.length > 0 ? 1 : 0;

    // 6. Контрольні перевірки доступу — щоб було видно, що кімната не просто
    //    «фільтр», а ще й закрита для чужих. Анонімний і чужий не мають пройти.
    const anonymous = await connect(null);
    sockets.push(anonymous);
    const ackAnon = await join(anonymous, ORDER_A);

    const foreigner = await connect(`${USER}-foreign`);
    sockets.push(foreigner);
    const ackForeign = await join(foreigner, ORDER_A);

    const deniedAnon = ackAnon.ok === false ? 1 : 0;
    const deniedForeign = ackForeign.ok === false ? 1 : 0;

    // Машинно-читані рядки — саме їх дивиться грейдер.
    console.log(`A_RECEIVED=${aReceived}`);
    console.log(`B_RECEIVED=${bReceived}`);
    console.log(`DENIED_ANONYMOUS=${deniedAnon}`);
    console.log(`DENIED_FOREIGN=${deniedForeign}`);

    if (aReceived !== 1) {
      failures.push('клієнт A не отримав подію своєї ж кімнати');
    }
    if (bReceived !== EXPECTED_B) {
      failures.push(
        SAME_ROOM
          ? 'контрольний прогін: обидва в одній кімнаті, але B нічого не отримав'
          : 'ізоляція порушена: B отримав подію чужої кімнати',
      );
    }
    if (deniedAnon !== 1) failures.push(`анонімного пустили в кімнату: ${JSON.stringify(ackAnon)}`);
    if (deniedForeign !== 1) {
      failures.push(`чужого пустили в кімнату: ${JSON.stringify(ackForeign)}`);
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  } finally {
    for (const socket of sockets) socket.close();
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`[demo] ПОМИЛКА: ${failure}`);
    log(`очікувалося B_RECEIVED=${EXPECTED_B}`);
    return 1;
  }

  log(`очікувалося B_RECEIVED=${EXPECTED_B} — збіглося`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`[demo] ПОМИЛКА: ${error?.message ?? error}`);
    process.exit(1);
  });
