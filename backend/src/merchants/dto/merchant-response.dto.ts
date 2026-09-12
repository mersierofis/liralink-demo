import { Merchant } from '../../generated/prisma/client';

export class MerchantResponseDto {
  id: string;
  email: string;
  businessName: string;
  iban?: string;
  autoSavePercent: number;
  unallocatedUSDC: string;
  createdAt: string;

  static fromEntity(merchant: Merchant): MerchantResponseDto {
    const dto = new MerchantResponseDto();
    dto.id = merchant.id;
    dto.email = merchant.email;
    dto.businessName = merchant.businessName;
    dto.iban = merchant.iban ?? undefined;
    dto.autoSavePercent = merchant.autoSavePercent;
    dto.unallocatedUSDC = merchant.unallocatedUSDC.toFixed(7);
    dto.createdAt = merchant.createdAt.toISOString();
    return dto;
  }
}
