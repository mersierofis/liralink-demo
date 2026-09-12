import { Injectable } from '@nestjs/common';
import { BALANCE_MODE_PROVIDERS } from '../anchor/anchor.adapter';
import { Decimal } from '../common/decimal';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BalanceDto } from './dto/balance.dto';

@Injectable()
export class BalanceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * availableTRY = Σ netTRY of completed balance-mode settlements − Σ non-failed withdrawals (a
   * withdrawal reserves its amount from the moment it's requested); paidOutTRY = Σ netTRY of
   * completed auto_payout settlements (the anchor already paid the IBAN — never withdrawable);
   * pendingTRY = Σ gross amountTRY of pending/processing settlements (the fee is known only on
   * completion); savedUSDC = Σ auto-saved USDC of non-failed settlements. The bucket follows the
   * provider a settlement was created with. unallocatedUSDC (overpaid links, stray payments) is
   * never folded into TRY.
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
    const credited = await completedNetTRY(db, merchantId, {
      in: BALANCE_MODE_PROVIDERS,
    });
    const paidOut = await completedNetTRY(db, merchantId, {
      notIn: BALANCE_MODE_PROVIDERS,
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
    return {
      availableTRY: credited.minus(withdrawn._sum.amountTRY ?? zero).toFixed(2),
      pendingTRY: (pending._sum.amountTRY ?? zero).toFixed(2),
      paidOutTRY: paidOut.toFixed(2),
      savedUSDC: (saved._sum.savedUSDC ?? zero).toFixed(7),
      unallocatedUSDC: merchant.unallocatedUSDC.toFixed(7),
    };
  }
}

/** Σ netTRY of completed settlements from these providers. Rows completed before fees were
 * recorded (mock, no fee) have netTRY null and count at their gross amountTRY. */
async function completedNetTRY(
  db: Prisma.TransactionClient,
  merchantId: string,
  provider: Prisma.SettlementWhereInput['provider'],
): Promise<Decimal> {
  const net = await db.settlement.aggregate({
    where: { merchantId, status: 'completed', provider, netTRY: { not: null } },
    _sum: { netTRY: true },
  });
  const legacy = await db.settlement.aggregate({
    where: { merchantId, status: 'completed', provider, netTRY: null },
    _sum: { amountTRY: true },
  });
  const zero = new Decimal(0);
  return (net._sum.netTRY ?? zero).plus(legacy._sum.amountTRY ?? zero);
}
