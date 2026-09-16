import { Memo } from '@stellar/stellar-sdk';
import { Decimal } from '../common/decimal';
import { BlockedReason } from './anchor.adapter';

/**
 * Helpers shared by the SEP-6 and SEP-24 adapters. The two specs describe the same `/info`
 * withdraw entry, the same transaction object and the same status vocabulary — only the way a
 * withdraw is *opened* differs (a GET with query params vs. a POST that returns an interactive
 * URL). `sep24.ts` re-exports these under their historical names.
 */

/** `GET {TRANSFER_SERVER}/info`, the parts we read. */
export interface AnchorInfo {
  withdraw?: Record<
    string,
    { enabled?: boolean; min_amount?: number; max_amount?: number }
  >;
}

/** `GET {TRANSFER_SERVER}/transaction?id=` → `transaction`, the parts we read. */
export interface TransferTransaction {
  id: string;
  status: string;
  message?: string;
  amount_in?: string;
  amount_in_asset?: string;
  /** What the anchor delivers off-chain — for a TRY withdraw, lira. */
  amount_out?: string | null;
  amount_out_asset?: string | null;
  amount_fee?: string | null;
  amount_fee_asset?: string | null;
  fee_details?: { total?: string; asset?: string } | null;
  withdraw_anchor_account?: string;
  withdraw_memo?: string;
  withdraw_memo_type?: string;
}

/**
 * The anchor's fee in `asset` (`stellar:CODE:ISSUER` or `iso4217:CODE`): `fee_details` (current
 * spec), else the deprecated `amount_fee`; no fee reported → 0. A fee without an asset is in the
 * asset sent. Null when it is in another asset — it can't be netted against `asset`.
 */
export function transferFeeIn(
  txn: TransferTransaction,
  asset: string,
): Decimal | null {
  const [total, feeAsset] =
    txn.fee_details?.total !== undefined
      ? [txn.fee_details.total, txn.fee_details.asset]
      : [txn.amount_fee, txn.amount_fee_asset];
  if (total === undefined || total === null) return new Decimal(0);
  const reported = feeAsset ?? txn.amount_in_asset ?? asset;
  return reported === asset ? new Decimal(total) : null;
}

/** What LiraLink does next for a withdraw status. */
export type TransferPhase =
  | 'interactive' // incomplete: KYC / amount form not submitted yet (SEP-24 only)
  | 'send_funds' // pending_user_transfer_start: we must send the USDC
  | 'in_progress' // any other pending_*: the anchor is working
  | 'completed'
  | 'failed';

const FAILED_STATUSES = new Set([
  'error',
  'expired',
  'refunded',
  'no_market',
  'too_small',
  'too_large',
]);

export function transferPhase(status: string): TransferPhase {
  if (status === 'incomplete') return 'interactive';
  if (status === 'pending_user_transfer_start') return 'send_funds';
  if (status === 'completed') return 'completed';
  if (FAILED_STATUSES.has(status)) return 'failed';
  return 'in_progress';
}

/** Why the anchor can't take this withdraw right now, or null if it can. */
export function withdrawBlock(
  info: AnchorInfo,
  assetCode: string,
  amount: Decimal,
): { reason: BlockedReason; detail: string } | null {
  const asset = info.withdraw?.[assetCode];
  if (!asset?.enabled) {
    return {
      reason: 'anchor_withdraw_disabled',
      detail: `anchor has withdraw disabled for ${assetCode}`,
    };
  }
  if (asset.min_amount !== undefined && amount.lessThan(asset.min_amount)) {
    return {
      reason: 'outside_anchor_limits',
      detail: `${amount.toFixed(7)} ${assetCode} is below the anchor minimum ${asset.min_amount}`,
    };
  }
  if (asset.max_amount !== undefined && amount.greaterThan(asset.max_amount)) {
    return {
      reason: 'outside_anchor_limits',
      detail: `${amount.toFixed(7)} ${assetCode} is above the anchor maximum ${asset.max_amount}`,
    };
  }
  return null;
}

/** The memo the anchor told us to attach (hash memos are base64). */
export function withdrawMemo(type?: string, value?: string): Memo {
  if (!value) return Memo.none();
  switch (type) {
    case 'id':
      return Memo.id(value);
    case 'text':
      return Memo.text(value);
    case 'hash':
      return Memo.hash(Buffer.from(value, 'base64'));
    default:
      throw new Error(`unsupported withdraw_memo_type "${type}"`);
  }
}
