import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  scryptSync,
  type KeyObject,
} from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import { envSchema } from '../config/env.schema';

/**
 * Підпис і перевірка токенів.
 *
 * ── Чому ES256, а не RS256 ──────────────────────────────────────────────────
 * OWASP позначає RS256 як «Not recommended» і радить ES256 / PS256 / EdDSA.
 * Практична різниця тут не в стійкості, а в розмірі: підпис ES256 — 64 байти
 * проти 256 у RS256 при 2048-бітному ключі, і це помітно на токені, який їде
 * в кожному запиті. Асиметрія сама по собі теж не косметика: верифікатору
 * достатньо ПУБЛІЧНОГО ключа, тож сервіс, який лише перевіряє токени, не може
 * виписати собі `role: admin` навіть якщо його зламали.
 *
 * ── Чому algorithms обовʼязковий ────────────────────────────────────────────
 * Явний allowlist у верифікації — єдиний надійний запобіжник від algorithm
 * confusion (RFC 8725 §3.1). Без нього бібліотека бере алгоритм із заголовка
 * ТОКЕНА, і зловмисник підсуває `alg: HS256`, підписуючи публічним ключем як
 * секретом — верифікація проходить. Тому `algorithms: ['ES256']` стоїть і тут,
 * і ніде більше не перевизначається.
 */
export const JWT_ALGORITHM = 'ES256' as const;
/** Єдиний allowlist алгоритмів на весь застосунок. */
export const ALLOWED_ALGORITHMS: jwt.Algorithm[] = [JWT_ALGORITHM];

export const ISSUER = 'marketplace-api';
export const AUDIENCE = 'marketplace-clients';

export type UserRole = 'buyer' | 'seller' | 'admin';

export interface AccessClaims extends jwt.JwtPayload {
  sub: string;
  jti: string;
  role: UserRole;
  /** Ідентифікатор сімʼї refresh-токенів цього логіна. */
  fid: string;
}

export interface AuthConfig {
  privateKey: KeyObject;
  publicKey: KeyObject;
  kid: string;
  pepper: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
}

/**
 * Читає конфіг ПЕРШОЮ дією процесу — до будь-якого підключення до бази.
 *
 * Інакше голий старт без ключа падав би на Postgres із ECONNREFUSED і не
 * назвав би змінної, якої бракує.
 */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const parsed = envSchema
    .pick({
      JWT_PRIVATE_KEY: true,
      JWT_PUBLIC_KEY: true,
      JWT_KID: true,
      REFRESH_TOKEN_PEPPER: true,
      ACCESS_TTL_S: true,
      REFRESH_TTL_S: true,
    })
    .parse(env);

  return {
    privateKey: createPrivateKey(decodePem(parsed.JWT_PRIVATE_KEY, 'JWT_PRIVATE_KEY')),
    publicKey: createPublicKey(decodePem(parsed.JWT_PUBLIC_KEY, 'JWT_PUBLIC_KEY')),
    kid: parsed.JWT_KID,
    pepper: parsed.REFRESH_TOKEN_PEPPER,
    accessTtlSeconds: parsed.ACCESS_TTL_S,
    refreshTtlSeconds: parsed.REFRESH_TTL_S,
  };
}

/** PEM приймаємо і в base64, і як є — щоб не ловити DECODER::unsupported. */
function decodePem(value: string, name: string): string {
  const raw = value.includes('-----BEGIN')
    ? value
    : Buffer.from(value, 'base64').toString('utf8');

  if (!raw.includes('-----BEGIN')) {
    throw new Error(`${name}: очікувався PEM (можна в base64), а прийшло щось інше`);
  }
  return raw;
}

/** Відбиток ключа — його можна й треба логувати, на відміну від самого ключа. */
export function keyFingerprint(key: KeyObject): string {
  const der = key.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('base64url').slice(0, 16);
}

export interface IssuedAccess {
  token: string;
  jti: string;
  expiresAt: Date;
}

export function signAccessToken(
  config: AuthConfig,
  claims: { sub: string; role: UserRole; fid: string },
): IssuedAccess {
  const jti = randomUUID();
  const token = jwt.sign({ role: claims.role, fid: claims.fid }, config.privateKey, {
    algorithm: JWT_ALGORITHM,
    // kid у заголовку — те, що робить overlap-ротацію можливою: верифікатор
    // бачить, яким саме ключем підписано, і не мусить гадати.
    keyid: config.kid,
    subject: claims.sub,
    jwtid: jti,
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: config.accessTtlSeconds,
  });

  return {
    token,
    jti,
    expiresAt: new Date(Date.now() + config.accessTtlSeconds * 1000),
  };
}

export class TokenError extends Error {}

/**
 * Перевірка підпису. Кидає TokenError на будь-яку проблему з токеном —
 * викликач перетворює це на 401, і лише на 401.
 */
export function verifyAccessToken(config: AuthConfig, token: string): AccessClaims {
  try {
    return jwt.verify(token, config.publicKey, {
      // Головний рядок усього файлу: allowlist, а не те, що написано в токені.
      algorithms: ALLOWED_ALGORITHMS,
      issuer: ISSUER,
      audience: AUDIENCE,
    }) as AccessClaims;
  } catch (error) {
    throw new TokenError(error instanceof Error ? error.message : 'невалідний токен');
  }
}

/**
 * Refresh — випадковий непрозорий рядок, а НЕ JWT.
 *
 * Він нічого не каже про себе, тож його неможливо «прочитати» без бази; і
 * навпаки — його неможливо перевірити без бази, що тут і потрібно: саме база
 * знає, чи його вже використали.
 */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * HMAC із «перцем» зі сховища, а не голий SHA-256.
 *
 * Голий хеш від випадкового 32-байтового рядка теж непогано (перебрати його
 * неможливо), але «перець» робить дамп таблиці марним навіть тоді, коли
 * витекла сама база: без ключа зі сховища зіставити хеш із токеном не вийде.
 */
export function hashRefreshToken(config: AuthConfig, token: string): string {
  return createHmac('sha256', config.pepper).update(token).digest('base64url');
}

/** Хеш пароля: scrypt + сіль, усе в одному рядку. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const [scheme, saltPart, hashPart] = stored.split('$');
  if (scheme !== 'scrypt' || !saltPart || !hashPart) return false;

  const expected = Buffer.from(hashPart, 'base64url');
  const actual = scryptSync(password, Buffer.from(saltPart, 'base64url'), expected.length);
  // Порівняння за сталий час: інакше час відповіді розповідає, скільки
  // перших байтів збіглося.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
