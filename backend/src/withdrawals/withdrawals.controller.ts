import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentMerchant } from '../auth/current-merchant.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import type { Merchant } from '../generated/prisma/client';
import { CreateWithdrawalDto } from './dto/create-withdrawal.dto';
import { WithdrawalResponseDto } from './dto/withdrawal-response.dto';
import { WithdrawalsService } from './withdrawals.service';

@UseGuards(JwtAuthGuard)
@Controller('withdrawals')
export class WithdrawalsController {
  constructor(private readonly withdrawalsService: WithdrawalsService) {}

  @Post()
  async create(
    @CurrentMerchant() merchant: Merchant,
    @Body() dto: CreateWithdrawalDto,
  ): Promise<WithdrawalResponseDto> {
    const withdrawal = await this.withdrawalsService.create(merchant.id, dto);
    return WithdrawalResponseDto.fromEntity(withdrawal);
  }

  @Get()
  async findAll(
    @CurrentMerchant() merchant: Merchant,
    @Query() query: PaginationQueryDto,
  ) {
    const { items, total } = await this.withdrawalsService.findAll(
      merchant.id,
      query.page ?? 1,
      query.limit ?? 20,
    );
    return {
      items: items.map((w) => WithdrawalResponseDto.fromEntity(w)),
      total,
    };
  }
}
