import { explorerTxUrl } from '../../common/explorer';
import type {
  UnallocatedCredit,
  UnallocatedSource,
} from '../unallocated.service';

/** Matches `UnallocatedCredit` in docs/api.types.ts. */
export class UnallocatedCreditDto {
  id: string;
  source: UnallocatedSource;
  txHash: string;
  explorerUrl: string;
  amountUSDC: string; // 7 dp — what this row added to unallocatedUSDC
  linkCode: string;
  reason: string;
  createdAt: string;

  static fromCredit(credit: UnallocatedCredit): UnallocatedCreditDto {
    const dto = new UnallocatedCreditDto();
    dto.id = credit.id;
    dto.source = credit.source;
    dto.txHash = credit.txHash;
    dto.explorerUrl = explorerTxUrl(credit.txHash);
    dto.amountUSDC = credit.amountUSDC.toFixed(7);
    dto.linkCode = credit.linkCode;
    dto.reason = credit.reason;
    dto.createdAt = credit.createdAt.toISOString();
    return dto;
  }
}
