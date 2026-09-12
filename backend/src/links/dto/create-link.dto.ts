import {
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';

export class CreateLinkDto {
  @IsString()
  @MinLength(1)
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  /** Decimal string, exactly 2 dp, e.g. "5000.00". Range (1.00–1,000,000) is enforced in the service. */
  @Matches(/^\d+\.\d{2}$/, {
    message: 'amountTRY must be a decimal string with exactly 2 decimal places',
  })
  amountTRY: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  expiresInHours?: number;
}
