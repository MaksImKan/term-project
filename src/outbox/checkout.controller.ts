import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Headers,
  HttpCode,
  NotFoundException,
  Post,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { DatabaseService } from '../db/database.service';
import { CheckoutError } from '../checkout';
import { placeOrder } from './place-order';

interface PlaceOrderBody {
  buyer_id: string;
  product_id: string;
  quantity: number;
}

/**
 * API-край критичної бізнес-операції (ДЗ-22).
 *
 * Тут живе третій рівень ідемпотентності — `Idempotency-Key`. Два однакові
 * запити з тим самим ключем дають ОДНЕ замовлення, і другий отримує ту саму
 * відповідь із заголовком `Idempotency-Replay: true`.
 *
 * Чому окремий ендпоїнт, а не `POST /orders`: той із ДЗ-09 лишається
 * in-memory стабом контракту (на ньому стоять e2e- і contract-тести ДЗ-16 та
 * SSE-потік ДЗ-18), а тут потрібні справжні рядки Postgres — інакше нема про
 * яку транзакційність говорити. Ключ ідемпотентності в обох місцях той самий
 * за змістом, але тільки цей переживає рестарт процесу.
 */
@Controller('checkout')
export class CheckoutController {
  constructor(private readonly db: DatabaseService) {}

  @Post()
  @HttpCode(201)
  async place(
    // Обовʼязковість заголовка вже перевірив валідатор зі спеки.
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() body: PlaceOrderBody,
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      const result = await placeOrder(await this.db.orm(), idempotencyKey, {
        buyerId: body.buyer_id,
        productId: body.product_id,
        quantity: body.quantity,
      });

      if (result.replay) res.setHeader('Idempotency-Replay', 'true');

      return {
        order_id: result.orderId,
        total_cents: result.totalCents,
        currency: 'UAH',
        stock_left: result.stockLeft,
        balance_left: result.balanceLeft,
        replay: result.replay,
        outbox_id: result.outboxId,
      };
    } catch (error) {
      throw toHttp(error);
    }
  }
}

/** Доменні відмови — у коди HTTP; усе інше лишаємо фільтру problem+json. */
function toHttp(error: unknown): unknown {
  if (!(error instanceof CheckoutError)) return error;

  switch (error.reason) {
    case 'no_such_product':
    case 'no_such_buyer':
      return new NotFoundException(error.message);
    case 'out_of_stock':
    case 'insufficient_funds':
      // 409, а не 400: запит коректний, не збігся стан.
      return new ConflictException(error.message);
    default:
      return new BadRequestException(error.message);
  }
}
