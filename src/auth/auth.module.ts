import { Module } from '@nestjs/common';
import {
  AccountOrdersController,
  AuthController,
  ProductsWriteController,
} from './auth.controller';
import { AuthGuard, RolesGuard } from './auth.guard';

/**
 * Автентифікація і авторизація (ДЗ-24).
 *
 * Гарди навмисно НЕ глобальні: інакше вони накрили б і публічні ресурси
 * ДЗ-09 (`GET /products`, SSE-потік ДЗ-18), і довелося б розставляти
 * `@Public()` по всьому проєкту — тобто за замовчуванням усе відкрите, а
 * закриває декоратор, який легко забути. Тут навпаки: гарди висять на
 * контролерах цього модуля, і кожен новий захищений ресурс додається свідомо.
 */
@Module({
  controllers: [AuthController, AccountOrdersController, ProductsWriteController],
  providers: [AuthGuard, RolesGuard],
})
export class AuthModule {}
