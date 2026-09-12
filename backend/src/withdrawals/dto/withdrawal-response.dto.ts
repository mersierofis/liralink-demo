import { Withdrawal } from '../../generated/prisma/client';

/** Matches `Withdrawal` in docs/api.types.ts. */
export class WithdrawalResponseDto {
  id: string;
  merchantId: string;
  amountTRY: string;
  iban: string;
  status: string;
  anchorRef?: string;
  createdAt: string;
  completedAt?: string;

  static fromEntity(withdrawal: Withdrawal): WithdrawalResponseDto {
    const dto = new WithdrawalResponseDto();
    dto.id = withdrawal.id;
    dto.merchantId = withdrawal.merchantId;
    dto.amountTRY = withdrawal.amountTRY.toFixed(2);
    dto.iban = withdrawal.iban;
    dto.status = withdrawal.status;
    dto.anchorRef = withdrawal.anchorRef ?? undefined;
    dto.createdAt = withdrawal.createdAt.toISOString();
    dto.completedAt = withdrawal.completedAt?.toISOString();
    return dto;
  }
}
