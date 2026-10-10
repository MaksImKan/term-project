import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrderEventsService } from './order-events.service';
import { OrdersGateway } from './orders.gateway';
import { ProductsModule } from '../products/products.module';

/**
 * Один модуль на три речі навколо замовлення: HTTP (контролер), домен (сервіс)
 * і realtime (шина + gateway).
 *
 * Gateway живе тут, а не в окремому RealtimeModule, бо йому потрібен
 * OrdersService для перевірки власника — окремий модуль дав би циклічну
 * залежність і forwardRef на рівному місці. А OrderEventsService навмисно
 * окремий провайдер: і контролер (SSE), і gateway (WS) підписані на нього, і
 * саме тому два транспорти не можуть розійтися.
 */
@Module({
  imports: [ProductsModule], // щоб інжектнути ProductsService для розрахунку суми
  controllers: [OrdersController],
  providers: [OrdersService, OrderEventsService, OrdersGateway],
  exports: [OrderEventsService],
})
export class OrdersModule {}
