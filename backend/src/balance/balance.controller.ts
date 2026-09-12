import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentMerchant } from '../auth/current-merchant.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { Merchant } from '../generated/prisma/client';
import { BalanceDto } from './dto/balance.dto';
import { BalanceService } from './balance.service';

@UseGuards(JwtAuthGuard)
@Controller('balance')
export class BalanceController {
  constructor(private readonly balanceService: BalanceService) {}

  @Get()
  getBalance(@CurrentMerchant() merchant: Merchant): Promise<BalanceDto> {
    return this.balanceService.getBalance(merchant.id);
  }
}
