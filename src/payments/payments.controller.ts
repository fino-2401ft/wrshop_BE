import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { CheckoutDto } from './dto';
import { PaymentsService } from './payments.service';

@Controller('api/payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('checkout')
  checkout(@Body() dto: CheckoutDto) {
    return this.payments.checkout(dto.publicCode, dto.buyerName, dto.phone, dto.email);
  }

  @Post('sepay/webhook')
  @HttpCode(200)
  webhook(@Req() req: Request) {
    return this.payments.handleWebhook(req.header('authorization'), req.body);
  }

  @Post(':code/complete')
  complete(@Param('code') code: string) {
    return this.payments.complete(code);
  }

  @Get(':code')
  getOne(@Param('code') code: string) {
    return this.payments.get(code);
  }
}
