import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
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
}
