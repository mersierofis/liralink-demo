import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentMerchant } from '../auth/current-merchant.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import type { Merchant } from '../generated/prisma/client';
import { SettlementResponseDto } from './dto/settlement-response.dto';
import { SettlementsService } from './settlements.service';

@UseGuards(JwtAuthGuard)
@Controller('settlements')
export class SettlementsController {
  constructor(private readonly settlementsService: SettlementsService) {}

  @Get()
  async findAll(
    @CurrentMerchant() merchant: Merchant,
    @Query() query: PaginationQueryDto,
  ) {
    const { items, total } = await this.settlementsService.findAll(
      merchant.id,
      query.page ?? 1,
      query.limit ?? 20,
    );
    return {
      items: items.map((s) => SettlementResponseDto.fromEntity(s)),
      total,
    };
  }
}
