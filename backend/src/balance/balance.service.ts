import { Injectable } from '@nestjs/common';
import { Decimal } from '../common/decimal';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BalanceDto } from './dto/balance.dto';

@Injectable()
export class BalanceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * availableTRY = Σ completed settlements − Σ non-failed withdrawals (a withdrawal reserves its
   * amount from the moment it's requested); pendingTRY = Σ pending/processing settlements;
   * savedUSDC = Σ auto-saved USDC of non-failed settlements. unallocatedUSDC (overpaid links,
   * stray payments) is never folded into TRY.
   *
   * Pass a transaction client to read inside a withdrawal's lock.
   */
  async getBalance(
    merchantId: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<BalanceDto> {
    const merchant = await db.merchant.findUniqueOrThrow({
      where: { id: merchantId },
    });
    const completed = await db.settlement.aggregate({
      where: { merchantId, status: 'completed' },
      _sum: { amountTRY: true },
    });
    const pending = await db.settlement.aggregate({
      where: { merchantId, status: { in: ['pending', 'processing'] } },
      _sum: { amountTRY: true },
    });
    const saved = await db.settlement.aggregate({
      where: { merchantId, status: { not: 'failed' } },
      _sum: { savedUSDC: true },
    });
    const withdrawn = await db.withdrawal.aggregate({
      where: { merchantId, status: { not: 'failed' } },
      _sum: { amountTRY: true },
    });

    const zero = new Decimal(0);
    const available = (completed._sum.amountTRY ?? zero).minus(
      withdrawn._sum.amountTRY ?? zero,
    );
    return {
      availableTRY: available.toFixed(2),
      pendingTRY: (pending._sum.amountTRY ?? zero).toFixed(2),
      savedUSDC: (saved._sum.savedUSDC ?? zero).toFixed(7),
      unallocatedUSDC: merchant.unallocatedUSDC.toFixed(7),
    };
  }
}
