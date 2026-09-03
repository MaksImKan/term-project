import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { OrdersService } from './orders.service';
import { CreateOrderBody } from '../models';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  list(@Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.orders.list({ limit, cursor });
  }

  @Get(':orderId')
  getById(@Param('orderId') orderId: string) {
    return this.orders.findOne(orderId);
  }

  @Post()
  @HttpCode(201)
  create(
    // Наявність заголовка вже гарантував валідатор (required у спеці).
    // Node віддає імена заголовків у lowercase, тож 'idempotency-key'.
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() body: CreateOrderBody,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { order, replay } = this.orders.create(idempotencyKey, body);
    if (replay) res.setHeader('Idempotency-Replay', 'true');
    return order; // Nest -> res.json(order) -> валідатор перевірить відповідь
  }
}
