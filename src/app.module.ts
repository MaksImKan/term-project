import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validate } from './config/env.schema';
import { DatabaseModule } from './db/database.module';
import { HealthModule } from './health/health.module';
import { ProductsModule } from './products/products.module';
import { OrdersModule } from './orders/orders.module';

@Module({
  imports: [
    // validate() відпрацьовує ДО створення DI-графа: зламана змінна означає,
    // що процес не підніметься взагалі, а не впаде на першому запиті в проді.
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env'],
      validate,
    }),
    DatabaseModule,
    HealthModule,
    ProductsModule,
    OrdersModule,
  ],
})
export class AppModule {}
