import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
} from 'class-validator';

export class UpdateMerchantDto {
  @IsOptional()
  @IsString()
  businessName?: string;

  @IsOptional()
  @Matches(/^TR\d{24}$/, { message: 'iban must match ^TR\\d{24}$' })
  iban?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(50)
  autoSavePercent?: number;

  // Password change: send both. newPassword follows the register rule (≥ 8 chars).
  @IsOptional()
  @IsString()
  currentPassword?: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  newPassword?: string;
}
