import { Injectable } from '@nestjs/common';
import { Decimal } from '../common/decimal';
import { PrismaService } from '../prisma/prisma.service';
import { BalanceDto } from './dto/balance.dto';

@Injectable()
export class BalanceService {
  constructor(private readonly prisma: PrismaService) {}

  async getBalance(merchantId: string): Promise<BalanceDto> {
    const merchant = await this.prisma.merchant.findUniqueOrThrow({
      where: { id: merchantId },
    });

    // Phase 2 (settlements + withdrawals) is not built yet, so the TRY-side figures
    // are still zero: availableTRY = Σ completed settlements − Σ non-failed withdrawals,
    // pendingTRY = Σ pending/processing settlements, savedUSDC = auto-save stretch.
    // unallocatedUSDC is LIVE today — it accrues from overpaid links (§1.6) and stray
    // payments (payment.stray), and is never auto-converted to TRY.
    return {
      availableTRY: new Decimal(0).toFixed(2),
      pendingTRY: new Decimal(0).toFixed(2),
      savedUSDC: new Decimal(0).toFixed(7),
      unallocatedUSDC: merchant.unallocatedUSDC.toFixed(7),
    };
  }
}
