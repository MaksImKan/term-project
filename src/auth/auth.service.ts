import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import {
  AuthConfig,
  IssuedAccess,
  UserRole,
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
  verifyPassword,
} from './tokens';

/**
 * Сесії: видача пари, ротація з детекцією повтору, логаут.
 *
 * Головна думка файлу — РОТАЦІЯ БЕЗ ДЕТЕКЦІЇ НІЧОГО НЕ ДАЄ. «Старий токен
 * більше не працює» саме по собі не захищає: злодій, який украв refresh,
 * просто рефрешиться першим. Чесний клієнт отримує 401, мовчки
 * перелогінюється — а сесія злодія живе далі, і ніхто про це не дізнався.
 *
 * Тому всі токени одного логіна належать одній СІМʼЇ (`family_id`), і
 * предʼявлення вже використаного токена трактується як сигнал компрометації:
 * відкликається вся сімʼя, обидва — і злодій, і чесний клієнт — вилітають.
 * Це рівно те, чого вимагає RFC 9700 §4.14.2: або sender-constrained токен,
 * або ротація з детекцією повтору.
 */

export class AuthError extends Error {
  constructor(
    readonly reason: 'invalid_credentials' | 'invalid_token' | 'reuse_detected',
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface TokenPair {
  access: IssuedAccess;
  refreshToken: string;
  familyId: string;
  userId: string;
  role: UserRole;
}

interface UserRow {
  id: string;
  role: UserRole;
  password_hash: string | null;
  is_active: boolean;
}

interface RefreshRow {
  id: string;
  family_id: string;
  user_id: string;
  used_at: Date | null;
  revoked_at: Date | null;
  expires_at: Date;
  role: UserRole;
}

export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: AuthConfig,
  ) {}

  /** Логін: перевіряємо пароль і відкриваємо НОВУ сімʼю токенів. */
  async login(email: string, password: string): Promise<TokenPair> {
    const rows = (await this.dataSource.query(
      'SELECT id, role, password_hash, is_active FROM users WHERE lower(email) = lower($1)',
      [email],
    )) as UserRow[];

    const user = rows[0];
    // Однакова відповідь на «немає такого» і «пароль не той»: інакше форма
    // логіна перетворюється на перелік існуючих адрес.
    if (!user || !user.is_active || !verifyPassword(password, user.password_hash)) {
      throw new AuthError('invalid_credentials', 'невірна пара логін/пароль');
    }

    return this.issuePair(this.dataSource.manager, user.id, user.role, randomUUID());
  }

  /**
   * Ротація. Усе — в одній транзакції: і позначка «використано», і видача
   * нової пари, і (у разі повтору) відкликання сімʼї.
   */
  async refresh(presentedToken: string): Promise<TokenPair> {
    const tokenHash = hashRefreshToken(this.config, presentedToken);

    // Транзакція повертає РІШЕННЯ, а не кидає виняток: кинути звідси означало б
    // відкотити відкликання сімʼї разом із самим винятком — тобто виявити
    // компрометацію і тут же забути про неї. Виняток летить уже після COMMIT.
    const outcome = await this.dataSource.transaction<
      | { kind: 'ok'; pair: TokenPair }
      | { kind: 'reuse'; familyId: string; userId: string }
      | { kind: 'invalid'; message: string }
    >(async (manager) => {
      // FOR UPDATE: два паралельні рефреші того самого токена не мають
      // розійтися у висновках про те, хто з них перший.
      const rows = (await manager.query(
        `SELECT rt.id, rt.family_id, rt.user_id, rt.used_at, rt.revoked_at, rt.expires_at, u.role
           FROM refresh_tokens rt
           JOIN users u ON u.id = rt.user_id
          WHERE rt.token_hash = $1
          FOR UPDATE OF rt`,
        [tokenHash],
      )) as RefreshRow[];

      const row = rows[0];
      if (!row) return { kind: 'invalid', message: 'refresh-токен невідомий' };
      if (row.revoked_at !== null) return { kind: 'invalid', message: 'refresh-токен відкликано' };

      // ── Сигнал компрометації ──────────────────────────────────────────────
      if (row.used_at !== null) {
        await this.revokeFamily(manager, row.family_id);
        return { kind: 'reuse', familyId: row.family_id, userId: row.user_id };
      }

      if (row.expires_at.getTime() <= Date.now()) {
        return { kind: 'invalid', message: 'refresh-токен протух' };
      }

      // Позначаємо використаним — саме ця позначка й робить повтор видимим.
      await manager.query('UPDATE refresh_tokens SET used_at = now() WHERE id = $1', [row.id]);

      return { kind: 'ok', pair: await this.issuePair(manager, row.user_id, row.role, row.family_id) };
    });

    if (outcome.kind === 'reuse') {
      // У лог іде family_id і користувач — не токен і не його хвіст.
      this.logger.warn(
        `reuse detected: сімʼю ${outcome.familyId} користувача ${outcome.userId} відкликано цілком`,
      );
      throw new AuthError(
        'reuse_detected',
        `повторне використання refresh-токена: сімʼю ${outcome.familyId} відкликано`,
      );
    }
    if (outcome.kind === 'invalid') throw new AuthError('invalid_token', outcome.message);

    return outcome.pair;
  }

  /**
   * Логаут — ДВІ дії, і обидві в одній транзакції.
   *
   * 1. `revoked_at` на всю сімʼю refresh-токенів: refresh — рядок у базі, його
   *    досить позначити.
   * 2. `jti` access-токена в денилист із TTL = залишок його життя: access
   *    self-contained і без денилиста працює до `exp`, скільки б разів
   *    користувач не натиснув «вийти».
   *
   * Якби перша дія йшла в Postgres, а друга — в Redis, це був би той самий
   * dual write, від якого ми тікали в ДЗ-22: падіння між ними лишає або
   * живий access, або живу сімʼю.
   */
  async logout(familyId: string, jti: string, accessExpiresAt: Date): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await this.revokeFamily(manager, familyId);
      await manager.query(
        `INSERT INTO access_denylist (jti, expires_at) VALUES ($1, $2)
         ON CONFLICT (jti) DO NOTHING`,
        [jti, accessExpiresAt],
      );
    });
  }

  /** Чи відкликаний цей access-токен. */
  async isAccessRevoked(jti: string): Promise<boolean> {
    const rows = (await this.dataSource.query(
      'SELECT 1 FROM access_denylist WHERE jti = $1 AND expires_at > now()',
      [jti],
    )) as unknown[];
    return rows.length > 0;
  }

  /** Чи жива сімʼя: логаут вбиває і ще не протухлі access-токени сімʼї. */
  async isFamilyRevoked(familyId: string): Promise<boolean> {
    const rows = (await this.dataSource.query(
      'SELECT 1 FROM refresh_tokens WHERE family_id = $1 AND revoked_at IS NOT NULL LIMIT 1',
      [familyId],
    )) as unknown[];
    return rows.length > 0;
  }

  /**
   * Прибирання денилиста. Запис живе рівно стільки, скільки лишилось токену:
   * без цього таблиця росте назавжди.
   */
  async purgeExpiredDenylist(): Promise<number> {
    const result = (await this.dataSource.query(
      'DELETE FROM access_denylist WHERE expires_at <= now() RETURNING jti',
    )) as unknown[];
    return Array.isArray(result) ? result.length : 0;
  }

  private async revokeFamily(manager: EntityManager, familyId: string): Promise<void> {
    await manager.query(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL',
      [familyId],
    );
  }

  private async issuePair(
    manager: EntityManager,
    userId: string,
    role: UserRole,
    familyId: string,
  ): Promise<TokenPair> {
    const refreshToken = generateRefreshToken();
    const expiresAt = new Date(Date.now() + this.config.refreshTtlSeconds * 1000);

    await manager.query(
      `INSERT INTO refresh_tokens (token_hash, family_id, user_id, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [hashRefreshToken(this.config, refreshToken), familyId, userId, expiresAt],
    );

    const access = signAccessToken(this.config, { sub: userId, role, fid: familyId });
    return { access, refreshToken, familyId, userId, role };
  }
}
