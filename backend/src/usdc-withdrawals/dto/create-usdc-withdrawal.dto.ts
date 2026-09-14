import { IsIn, IsString, Matches } from 'class-validator';
import type { UsdcWdSource } from '../../generated/prisma/client';

export class CreateUsdcWithdrawalDto {
  /** Decimal string, exactly 7 dp, > 0 and ≤ the source balance (422 otherwise). */
  @Matches(/^\d+\.\d{7}$/, {
    message:
      'amountUSDC must be a decimal string with exactly 7 decimal places',
  })
  amountUSDC: string;

  /** The merchant's own Stellar account (G…, checksum verified). On Horizon it must exist and trust
   * USDC with room for the amount (422 with a plain message otherwise). */
  @IsString()
  @Matches(/^G[A-Z2-7]{55}$/, {
    message: 'destination must be a Stellar account address (G…)',
  })
  destination: string;

  /** Which balance pays for it: savedUSDC or unallocatedUSDC. */
  @IsIn(['saved', 'unallocated'], {
    message: "source must be 'saved' or 'unallocated'",
  })
  source: UsdcWdSource;
}
