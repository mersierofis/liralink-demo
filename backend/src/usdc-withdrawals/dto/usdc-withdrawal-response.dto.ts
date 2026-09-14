import { explorerTxUrl } from '../../common/explorer';
import {
  UsdcWdSource,
  UsdcWdStatus,
  UsdcWithdrawal,
} from '../../generated/prisma/client';
import type { UsdcWdFailReason } from '../usdc-withdrawals.service';

/** Matches `UsdcWithdrawal` in docs/api.types.ts. */
export class UsdcWithdrawalResponseDto {
  id: string;
  merchantId: string;
  amountUSDC: string;
  destination: string;
  source: UsdcWdSource;
  status: UsdcWdStatus;
  txHash: string;
  explorerUrl: string;
  failReason: UsdcWdFailReason | null;
  createdAt: string;
  completedAt?: string;

  static fromEntity(withdrawal: UsdcWithdrawal): UsdcWithdrawalResponseDto {
    const dto = new UsdcWithdrawalResponseDto();
    dto.id = withdrawal.id;
    dto.merchantId = withdrawal.merchantId;
    dto.amountUSDC = withdrawal.amountUSDC.toFixed(7);
    dto.destination = withdrawal.destination;
    dto.source = withdrawal.source;
    dto.status = withdrawal.status;
    dto.txHash = withdrawal.txHash;
    dto.explorerUrl = explorerTxUrl(withdrawal.txHash);
    dto.failReason = withdrawal.failReason as UsdcWdFailReason | null;
    dto.createdAt = withdrawal.createdAt.toISOString();
    dto.completedAt = withdrawal.completedAt?.toISOString();
    return dto;
  }
}
