import { Module } from '@nestjs/common';
import { CheckoutController } from './checkout.controller';

/**
 * API-край транзакційної бізнес-операції (ДЗ-22).
 *
 * Окремий модуль, а не доважок до OrdersModule: той тримає in-memory стаб
 * контракту ДЗ-09 разом із realtime ДЗ-18, і змішувати з ним операцію, яка
 * працює зі справжніми рядками Postgres, означало б мати два джерела правди
 * в одному місці. Залежність тут одна — DatabaseService, і він глобальний.
 */
@Module({
  controllers: [CheckoutController],
})
export class CheckoutModule {}
