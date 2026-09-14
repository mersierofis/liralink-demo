import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentMerchant } from '../auth/current-merchant.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import type { Merchant } from '../generated/prisma/client';
import { CreateUsdcWithdrawalDto } from './dto/create-usdc-withdrawal.dto';
import { UsdcWithdrawalResponseDto } from './dto/usdc-withdrawal-response.dto';
import { UsdcWithdrawalsService } from './usdc-withdrawals.service';

@UseGuards(JwtAuthGuard)
@Controller('usdc-withdrawals')
export class UsdcWithdrawalsController {
  constructor(
    private readonly usdcWithdrawalsService: UsdcWithdrawalsService,
  ) {}

  @Post()
  async create(
    @CurrentMerchant() merchant: Merchant,
    @Body() dto: CreateUsdcWithdrawalDto,
  ): Promise<UsdcWithdrawalResponseDto> {
    const withdrawal = await this.usdcWithdrawalsService.create(
      merchant.id,
      dto,
    );
    return UsdcWithdrawalResponseDto.fromEntity(withdrawal);
  }

  @Get()
  async findAll(
    @CurrentMerchant() merchant: Merchant,
    @Query() query: PaginationQueryDto,
  ) {
    const { items, total } = await this.usdcWithdrawalsService.findAll(
      merchant.id,
      query.page ?? 1,
      query.limit ?? 20,
    );
    return {
      items: items.map((w) => UsdcWithdrawalResponseDto.fromEntity(w)),
      total,
    };
  }
}
