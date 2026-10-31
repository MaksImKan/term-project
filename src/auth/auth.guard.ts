import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { DatabaseService } from '../db/database.service';
import { AuthService } from './auth.service';
import { AccessClaims, TokenError, UserRole, loadAuthConfig, verifyAccessToken } from './tokens';

/**
 * 401 проти 403 — розділені жорстко, і це не стильова дрібниця.
 *
 * Клієнтський SDK на 401 іде рефрешити токен, а на 403 показує помилку.
 * Переплутав — і застосунок або зациклюється на рефреші (403 замість 401),
 * або вилогінює користувача на кожній чужій сторінці (401 замість 403).
 *
 *   немає / протух / зіпсований токен  -> 401 (AuthGuard)
 *   токен валідний, але прав немає     -> 403 (RolesGuard або перевірка
 *                                             власності в сервісі)
 */

export interface AuthenticatedRequest extends Request {
  auth?: AccessClaims;
}

export const ROLES_KEY = 'auth:roles';
/** Ролі, яким дозволено операцію. Відсутність декоратора = будь-яка роль. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

export const PUBLIC_KEY = 'auth:public';
/** Явно публічна операція: гард пропускає без токена. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('потрібен Bearer-токен');
    }

    const config = loadAuthConfig();
    let claims: AccessClaims;
    try {
      claims = verifyAccessToken(config, header.slice('Bearer '.length));
    } catch (error) {
      // Підроблений payload зі старим підписом потрапляє саме сюди — і саме
      // тому це 401, а не 403: токен недійсний, а не прав бракує.
      throw new UnauthorizedException(
        error instanceof TokenError ? error.message : 'невалідний токен',
      );
    }

    const auth = new AuthService(await this.db.orm(), config);

    // Денилист — друга половина логауту. Без цієї перевірки access-токен
    // лишався б робочим до exp навіть після виходу.
    if (await auth.isAccessRevoked(claims.jti)) {
      throw new UnauthorizedException('токен відкликано');
    }
    // Відкликана сімʼя означає логаут або виявлену компрометацію.
    if (await auth.isFamilyRevoked(claims.fid)) {
      throw new UnauthorizedException('сесію завершено');
    }

    request.auth = claims;
    return true;
  }
}

/**
 * Перевірка РОЛІ — доречна в гарді: вона не потребує даних про ресурс,
 * усе потрібне вже в токені.
 *
 * Перевірки ВЛАСНОСТІ тут немає свідомо: гард стоїть до того, як ресурс
 * завантажено, і щоб дізнатися власника, йому довелося б самому піти в базу —
 * тобто зробити той самий запит двічі. Власність перевіряється там, де ресурс
 * уже є: у `WHERE owner_id = $user` або в сервісі після завантаження.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const role = request.auth?.role;

    if (!role) throw new UnauthorizedException('немає автентифікації');
    if (!required.includes(role)) {
      throw new ForbiddenException(`потрібна роль: ${required.join(' або ')}`);
    }
    return true;
  }
}
