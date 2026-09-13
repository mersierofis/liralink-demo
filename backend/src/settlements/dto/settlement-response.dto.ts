import { sep24Phase } from '../../anchor/sep24';
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
  feeUSDC: string | null; // 7 dp — null until completed
  netTRY: string | null; // 2 dp — null until completed
  provider: string;
  status: string;
  anchorRef?: string;
  failReason: string | null; // set only when status is 'failed'
  interactiveUrl: string | null; // the anchor's KYC form — set only while it waits for the merchant
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
    // Completed before fees were recorded (mock, no fee): net = gross — same as BalanceService.
    const legacy =
      settlement.status === 'completed' && settlement.netTRY === null;
    dto.feeUSDC = legacy
      ? '0.0000000'
      : (settlement.feeUSDC?.toFixed(7) ?? null);
    dto.netTRY = legacy
      ? settlement.amountTRY.toFixed(2)
      : (settlement.netTRY?.toFixed(2) ?? null);
    dto.provider = settlement.provider;
    dto.status = settlement.status;
    dto.anchorRef = settlement.anchorRef ?? undefined;
    dto.failReason =
      settlement.status === 'failed' ? (settlement.failReason ?? null) : null;
    const awaitingMerchant =
      settlement.status === 'processing' &&
      settlement.anchorStatus !== null &&
      sep24Phase(settlement.anchorStatus) === 'interactive';
    dto.interactiveUrl = awaitingMerchant
      ? (settlement.interactiveUrl ?? null)
      : null;
    dto.createdAt = settlement.createdAt.toISOString();
    dto.completedAt = settlement.completedAt?.toISOString();
    return dto;
  }
}
