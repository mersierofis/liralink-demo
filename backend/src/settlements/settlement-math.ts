import { Decimal } from '../common/decimal';

export interface SettlementAmounts {
  /** USDC handed to the anchor for conversion. */
  amountUSDC: Decimal;
  /** TRY credited to the merchant once the settlement completes. */
  amountTRY: Decimal;
  /** USDC kept back by auto-save (ledgered only; DeFindex deposit is a stretch). */
  savedUSDC: Decimal;
}

/**
 * Splits a paid link per docs/01-BACKEND.md §2.2. TRY always derives from the locked
 * `link.amountTRY` — never `receivedUSDC × rate`, so overpayment excess (already in
 * unallocatedUSDC) never inflates it. `autoSavePercent` keeps that share of the quoted USDC
 * and reduces the TRY credit by the same share. Saved USDC rounds down (the platform never
 * ledgers more than it holds); TRY rounds half-up to kuruş.
 */
export function splitSettlement(
  linkAmountTRY: Decimal,
  quotedUSDC: Decimal,
  autoSavePercent: number,
): SettlementAmounts {
  const savedUSDC = quotedUSDC
    .times(autoSavePercent)
    .div(100)
    .toDecimalPlaces(7, Decimal.ROUND_DOWN);
  const amountTRY = linkAmountTRY
    .times(100 - autoSavePercent)
    .div(100)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return { amountUSDC: quotedUSDC.minus(savedUSDC), amountTRY, savedUSDC };
}
