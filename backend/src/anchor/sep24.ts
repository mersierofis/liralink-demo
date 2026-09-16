/**
 * SEP-24 helpers. The transaction object, the `/info` withdraw entry, the status vocabulary and
 * the memo rules are shared with SEP-6 and live in `transfer.ts`; they keep their historical
 * `sep24…` names here so the SEP-24 adapter and its spec read as before.
 */
export { jwtExpiresAt } from './anchor-session';
export {
  withdrawBlock,
  withdrawMemo,
  type AnchorInfo as Sep24Info,
  type TransferTransaction as Sep24Transaction,
  type TransferPhase as Sep24Phase,
  transferFeeIn as sep24FeeIn,
  transferPhase as sep24Phase,
} from './transfer';

import { Decimal } from '../common/decimal';
import { TransferTransaction, transferFeeIn } from './transfer';

/**
 * The anchor's fee in our USDC (`usdcAsset` = `stellar:CODE:ISSUER`). Null when it is in another
 * asset — it can't be netted against the USDC.
 */
export function sep24FeeUSDC(
  txn: TransferTransaction,
  usdcAsset: string,
): Decimal | null {
  return transferFeeIn(txn, usdcAsset);
}
