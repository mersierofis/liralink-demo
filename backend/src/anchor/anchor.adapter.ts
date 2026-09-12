import { Decimal } from '../common/decimal';
import { Merchant, SettleStatus } from '../generated/prisma/client';

export const ANCHOR_ADAPTER = Symbol('ANCHOR_ADAPTER');

/** USDC → TRY settlement and TRY payout to an IBAN (docs/01-BACKEND.md §2.1).
 * `mock` today; the SEP-24 adapter is phase 2 part E. */
export interface AnchorAdapter {
  readonly name: 'mock' | 'sep24';
  settleToTRY(input: {
    settlementId: string;
    amountUSDC: Decimal;
    merchant: Merchant;
  }): Promise<{ ref: string }>;
  payoutTRY(input: {
    withdrawalId: string;
    amountTRY: Decimal;
    iban: string;
  }): Promise<{ ref: string }>;
  getStatus(ref: string): Promise<SettleStatus>;
}
