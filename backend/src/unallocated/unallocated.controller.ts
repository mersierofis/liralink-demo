import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentMerchant } from '../auth/current-merchant.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import type { Merchant } from '../generated/prisma/client';
import { UnallocatedCreditDto } from './dto/unallocated-credit.dto';
import { UnallocatedService } from './unallocated.service';

@UseGuards(JwtAuthGuard)
@Controller('unallocated')
export class UnallocatedController {
  constructor(private readonly unallocatedService: UnallocatedService) {}

  @Get()
  async findAll(
    @CurrentMerchant() merchant: Merchant,
    @Query() query: PaginationQueryDto,
  ) {
    const { items, total, summary } = await this.unallocatedService.findAll(
      merchant.id,
      query.page ?? 1,
      query.limit ?? 20,
    );
    return {
      items: items.map((c) => UnallocatedCreditDto.fromCredit(c)),
      total,
      // Over all pages, not just this one — reconciles with Balance.unallocatedUSDC.
      summary: {
        creditedUSDC: summary.creditedUSDC.toFixed(7),
        withdrawnUSDC: summary.withdrawnUSDC.toFixed(7),
        remainingUSDC: summary.remainingUSDC.toFixed(7),
      },
    };
  }
}
