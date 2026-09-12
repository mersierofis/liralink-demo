import { IsOptional, Matches } from 'class-validator';

export class CreateWithdrawalDto {
  /** Decimal string, exactly 2 dp, > 0 and ≤ availableTRY (422 otherwise). */
  @Matches(/^\d+\.\d{2}$/, {
    message: 'amountTRY must be a decimal string with exactly 2 decimal places',
  })
  amountTRY: string;

  /** Falls back to the merchant's profile IBAN (PATCH /me). */
  @IsOptional()
  @Matches(/^TR\d{24}$/, { message: 'iban must match ^TR\\d{24}$' })
  iban?: string;
}
