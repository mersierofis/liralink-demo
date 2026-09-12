import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentMerchant } from '../auth/current-merchant.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import type { Merchant } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SettlementResponseDto } from '../settlements/dto/settlement-response.dto';
import { PaymentResponseDto } from './dto/payment-response.dto';

/** One row per transfer; `settlement` is null for installments that didn't complete the link. */
interface PaymentListItem extends PaymentResponseDto {
  link: { code: string; title: string; amountTRY: string };
  settlement: SettlementResponseDto | null;
}

@UseGuards(JwtAuthGuard)
@Controller('payments')
export class PaymentsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async findAll(
    @CurrentMerchant() merchant: Merchant,
    @Query() query: PaginationQueryDto,
  ): Promise<{ items: PaymentListItem[]; total: number }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where = { link: { merchantId: merchant.id } };

    const [payments, total] = await this.prisma.$transaction([
      this.prisma.payment.findMany({
        where,
        include: {
          link: { select: { code: true, title: true, amountTRY: true } },
          settlement: true,
        },
        orderBy: { detectedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.payment.count({ where }),
    ]);

    return {
      items: payments.map((p) => ({
        ...PaymentResponseDto.fromEntity(p),
        link: {
          code: p.link.code,
          title: p.link.title,
          amountTRY: p.link.amountTRY.toFixed(2),
        },
        settlement: p.settlement
          ? SettlementResponseDto.fromEntity(p.settlement)
          : null,
      })),
      total,
    };
  }
}
