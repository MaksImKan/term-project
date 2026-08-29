import { Controller, Get, Param, Query } from '@nestjs/common';
import { ProductsService } from './products.service';

@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  list(@Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.products.list({ limit, cursor });
  }

  @Get(':productId')
  getById(@Param('productId') productId: string) {
    return this.products.findOne(productId);
  }
}
