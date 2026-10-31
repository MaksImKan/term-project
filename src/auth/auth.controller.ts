import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { AuthError, AuthService } from './auth.service';
import { AuthGuard, AuthenticatedRequest, Public, Roles, RolesGuard } from './auth.guard';
import { loadAuthConfig } from './tokens';

interface LoginBody {
  email: string;
  password: string;
}

interface RefreshBody {
  refresh_token: string;
}

interface CreateProductBody {
  name: string;
  description: string;
  price_cents: number;
  stock: number;
}

/** Видача, ротація і завершення сесій. */
@Controller('auth')
@UseGuards(AuthGuard, RolesGuard)
export class AuthController {
  constructor(private readonly db: DatabaseService) {}

  private async service(): Promise<AuthService> {
    return new AuthService(await this.db.orm(), loadAuthConfig());
  }

  @Post('login')
  @Public()
  @HttpCode(200)
  async login(@Body() body: LoginBody) {
    try {
      const pair = await (await this.service()).login(body.email, body.password);
      return toPairResponse(pair);
    } catch (error) {
      throw toHttp(error);
    }
  }

  @Post('refresh')
  @Public()
  @HttpCode(200)
  async refresh(@Body() body: RefreshBody) {
    try {
      const pair = await (await this.service()).refresh(body.refresh_token);
      return toPairResponse(pair);
    } catch (error) {
      throw toHttp(error);
    }
  }

  /**
   * Логаут. Потребує чинного access-токена: саме з нього беремо `jti` для
   * денилиста і `fid` — сімʼю, яку треба відкликати.
   */
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() request: AuthenticatedRequest): Promise<void> {
    const claims = request.auth;
    if (!claims) throw new UnauthorizedException('немає автентифікації');

    const expiresAt = new Date((claims.exp ?? 0) * 1000);
    await (await this.service()).logout(claims.fid, claims.jti, expiresAt);
  }
}

/**
 * Ресурс із ВЛАСНИКОМ: замовлення автентифікованого користувача.
 *
 * Окремий шлях, а не `/orders/{id}` з ДЗ-09: той лишається in-memory стабом
 * контракту, на якому стоять тести ДЗ-16 і SSE-потік ДЗ-18. Тут — справжні
 * рядки Postgres, у яких є `buyer_id`, тобто є що порівнювати з `sub`.
 */
@Controller('account/orders')
@UseGuards(AuthGuard, RolesGuard)
export class AccountOrdersController {
  constructor(private readonly db: DatabaseService) {}

  @Get(':orderId')
  async getOne(
    @Param('orderId') orderId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    const claims = request.auth!;
    const ds = await this.db.orm();

    if (!/^[0-9]{1,18}$/.test(orderId)) throw new NotFoundException('замовлення не знайдено');

    // Власність перевіряється ТУТ, де ресурс уже завантажено, а не в гарді:
    // гард стоїть до завантаження і мусив би сходити в базу сам — тобто
    // зробити той самий запит двічі.
    //
    // Навмисно не `WHERE buyer_id = $user`: такий запит на чуже замовлення дав
    // би 404, і клієнт не відрізнив би «немає» від «не твоє». Для цього API
    // різниця важлива, тож вантажимо рядок і порівнюємо явно.
    const rows = (await ds.query(
      'SELECT id, buyer_id, status, total_cents, currency FROM orders WHERE id = $1',
      [orderId],
    )) as Array<{
      id: string;
      buyer_id: string;
      status: string;
      total_cents: number;
      currency: string;
    }>;

    const order = rows[0];
    if (!order) throw new NotFoundException('замовлення не знайдено');

    if (order.buyer_id !== claims.sub && claims.role !== 'admin') {
      // 403, а не 404: токен валідний, просто прав на цей ресурс немає.
      throw new ForbiddenException('це замовлення належить іншому користувачу');
    }

    return {
      id: order.id,
      buyer_id: order.buyer_id,
      status: order.status,
      total_cents: order.total_cents,
      currency: order.currency,
    };
  }
}

/**
 * Ресурс із РОЛЬОВИМ доступом: у каталог пише лише продавець або адмін.
 *
 * Тут усе навпаки: даних про ресурс не потрібно взагалі — рішення приймається
 * з того, що вже є в токені. Саме такі перевірки й належать гарду.
 */
@Controller('products')
@UseGuards(AuthGuard, RolesGuard)
export class ProductsWriteController {
  constructor(private readonly db: DatabaseService) {}

  @Post()
  @Roles('seller', 'admin')
  @HttpCode(201)
  async create(@Body() body: CreateProductBody, @Req() request: AuthenticatedRequest) {
    const claims = request.auth!;
    if (!body?.name || typeof body.price_cents !== 'number') {
      throw new BadRequestException('потрібні name і price_cents');
    }

    const ds = await this.db.orm();
    const rows = (await ds.query(
      `INSERT INTO products (seller_id, name, description, price_cents, currency, stock)
       VALUES ($1, $2, $3, $4, 'UAH', $5)
       RETURNING id, name, price_cents, currency, stock`,
      [claims.sub, body.name, body.description ?? '', body.price_cents, body.stock ?? 0],
    )) as Array<{
      id: string;
      name: string;
      price_cents: number;
      currency: string;
      stock: number;
    }>;

    return { ...rows[0], seller_id: claims.sub };
  }
}

function toPairResponse(pair: {
  access: { token: string; expiresAt: Date };
  refreshToken: string;
  role: string;
  userId: string;
}) {
  return {
    access_token: pair.access.token,
    refresh_token: pair.refreshToken,
    token_type: 'Bearer',
    expires_in: Math.max(1, Math.round((pair.access.expiresAt.getTime() - Date.now()) / 1000)),
    role: pair.role,
    user_id: pair.userId,
  };
}

/**
 * Усі проблеми з токеном і креденшелами — 401. Жодного 403 тут бути не може:
 * 403 означає «ми знаємо, хто ти, і тобі не можна», а на цьому етапі ми ще
 * не знаємо, хто це.
 */
function toHttp(error: unknown): unknown {
  if (error instanceof AuthError) return new UnauthorizedException(error.message);
  return error;
}
