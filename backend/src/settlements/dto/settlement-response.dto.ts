import { Settlement } from '../../generated/prisma/client';

/** Matches `Settlement` in docs/api.types.ts. */
export class SettlementResponseDto {
  id: string;
  merchantId: string;
  paymentId: string;
  amountUSDC: string;
  amountTRY: string;
  fxRate: string;
  savedUSDC: string;
  provider: string;
  status: string;
  anchorRef?: string;
  createdAt: string;
  completedAt?: string;

  static fromEntity(settlement: Settlement): SettlementResponseDto {
    const dto = new SettlementResponseDto();
    dto.id = settlement.id;
    dto.merchantId = settlement.merchantId;
    dto.paymentId = settlement.paymentId;
    dto.amountUSDC = settlement.amountUSDC.toFixed(7);
    dto.amountTRY = settlement.amountTRY.toFixed(2);
    dto.fxRate = settlement.fxRate.toFixed(7);
    dto.savedUSDC = settlement.savedUSDC.toFixed(7);
    dto.provider = settlement.provider;
    dto.status = settlement.status;
    dto.anchorRef = settlement.anchorRef ?? undefined;
    dto.createdAt = settlement.createdAt.toISOString();
    dto.completedAt = settlement.completedAt?.toISOString();
    return dto;
  }
}
