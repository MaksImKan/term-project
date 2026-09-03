import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { ProductsModule } from '../products/products.module';

@Module({
  imports: [ProductsModule], // щоб інжектнути ProductsService для розрахунку суми
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
