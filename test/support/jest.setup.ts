import { generateKeyPairSync } from 'node:crypto';

/**
 * Ключі підпису для тестів — генеруються на кожен прогін.
 *
 * Схема конфігурації (ДЗ-24) навмисно не має дефолтів для ключів: дефолт
 * дорівнював би зашитому в код ключу. Тому тести мусять дати свої — і дають
 * щоразу нові, одноразові. Жодного ключа в репозиторії від цього не зʼявляється.
 *
 * `setupFiles` виконується ДО завантаження модулів тесту, тобто до того, як
 * будь-який `import` потягне app.module і запустить валідацію конфігу.
 */
const pair = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

process.env.JWT_PRIVATE_KEY ??= Buffer.from(pair.privateKey).toString('base64');
process.env.JWT_PUBLIC_KEY ??= Buffer.from(pair.publicKey).toString('base64');
process.env.JWT_KID ??= 'test-es256';
process.env.REFRESH_TOKEN_PEPPER ??= 'test-pepper-0123456789';
