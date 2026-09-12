import type { SettlementMode } from '../../anchor/anchor.adapter';
import { Merchant } from '../../generated/prisma/client';

export class MerchantResponseDto {
  id: string;
  email: string;
  businessName: string;
  iban?: string;
  autoSavePercent: number;
  unallocatedUSDC: string;
  settlementMode: SettlementMode;
  createdAt: string;

  static fromEntity(
    merchant: Merchant,
    settlementMode: SettlementMode,
  ): MerchantResponseDto {
    const dto = new MerchantResponseDto();
    dto.id = merchant.id;
    dto.email = merchant.email;
    dto.businessName = merchant.businessName;
    dto.iban = merchant.iban ?? undefined;
    dto.autoSavePercent = merchant.autoSavePercent;
    dto.unallocatedUSDC = merchant.unallocatedUSDC.toFixed(7);
    dto.settlementMode = settlementMode;
    dto.createdAt = merchant.createdAt.toISOString();
    return dto;
  }
}
