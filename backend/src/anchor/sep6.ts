import { Decimal } from '../common/decimal';
import {
  TransferPhase,
  TransferTransaction,
  transferFeeIn,
  transferPhase,
} from './transfer';

/** `GET {TRANSFER_SERVER}/withdraw` (SEP-6), the parts we read. */
export interface Sep6WithdrawResponse {
  id: string;
  account_id: string;
  memo?: string;
  memo_type?: string;
  min_amount?: number;
  max_amount?: number;
}

/**
 * SEP-6 is programmatic: there is no interactive page, so `incomplete` — which in SEP-24 means
 * "the customer has not filled the form yet" — has nothing LiraLink can act on. It is treated as
 * a pending anchor state: the minute job keeps checking, and the anchor's own deadline ends it.
 */
export function sep6Phase(status: string): TransferPhase {
  const phase = transferPhase(status);
  return phase === 'interactive' ? 'in_progress' : phase;
}

/** What a completed SEP-6 withdrawal actually delivered, or why it can't be booked. */
export type Sep6Payout =
  | { ok: true; feeUSDC: Decimal; netTRY: Decimal | null }
  | { ok: false; detail: string };

/**
 * Reads the amounts off a `completed` withdrawal.
 *
 * `amount_out` is the fiat the anchor paid out, so when it is denominated in TRY it *is* the net
 * figure and is preferred over deriving one from the fee. `feeUSDC` is only recorded when the
 * anchor denominates its fee in our USDC; a fee charged in TRY is already reflected in
 * `amount_out`, so counting it again would net it twice.
 *
 * Fails only when neither is usable: a fee in a third asset with no TRY `amount_out` leaves
 * nothing that can be credited honestly.
 */
export function sep6Payout(
  txn: TransferTransaction,
  usdcAsset: string,
  tryAsset: string,
): Sep6Payout {
  const netTRY =
    txn.amount_out != null && txn.amount_out_asset === tryAsset
      ? new Decimal(txn.amount_out)
      : null;
  if (netTRY?.isNegative()) {
    return {
      ok: false,
      detail: `anchor reported a negative amount_out (${txn.amount_out} ${tryAsset})`,
    };
  }

  const feeUSDC = transferFeeIn(txn, usdcAsset);
  if (feeUSDC) return { ok: true, feeUSDC, netTRY };

  // The fee is in another asset. Fine when the anchor also told us the TRY it paid — that figure
  // is already net of it — but otherwise there is no way to net it against the USDC.
  if (netTRY) return { ok: true, feeUSDC: new Decimal(0), netTRY };
  return {
    ok: false,
    detail:
      `withdrawal completed with its fee in ` +
      `${JSON.stringify(txn.fee_details ?? { amount_fee: txn.amount_fee, amount_fee_asset: txn.amount_fee_asset })}, ` +
      `not ${usdcAsset}, and no ${tryAsset} amount_out to fall back on`,
  };
}
