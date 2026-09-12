import { Memo } from '@stellar/stellar-sdk';
import { Decimal } from '../common/decimal';
import { BlockedReason } from './anchor.adapter';

/** `GET {TRANSFER_SERVER_SEP0024}/info`, the parts we read. */
export interface Sep24Info {
  withdraw?: Record<
    string,
    { enabled?: boolean; min_amount?: number; max_amount?: number }
  >;
}

/** `GET {TRANSFER_SERVER_SEP0024}/transaction?id=` → `transaction`, the parts we read. */
export interface Sep24Transaction {
  id: string;
  status: string;
  message?: string;
  amount_in?: string;
  withdraw_anchor_account?: string;
  withdraw_memo?: string;
  withdraw_memo_type?: string;
}

/** What LiraLink does next for a SEP-24 withdraw status. */
export type Sep24Phase =
  | 'interactive' // incomplete: KYC / amount form not submitted yet
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

export function sep24Phase(status: string): Sep24Phase {
  if (status === 'incomplete') return 'interactive';
  if (status === 'pending_user_transfer_start') return 'send_funds';
  if (status === 'completed') return 'completed';
  if (FAILED_STATUSES.has(status)) return 'failed';
  return 'in_progress';
}

/** Why the anchor can't take this withdraw right now, or null if it can. */
export function withdrawBlock(
  info: Sep24Info,
  assetCode: string,
  amount: Decimal,
): { reason: BlockedReason; detail: string } | null {
  const asset = info.withdraw?.[assetCode];
  if (!asset?.enabled) {
    return {
      reason: 'anchor_withdraw_disabled',
      detail: `anchor has SEP-24 withdraw disabled for ${assetCode}`,
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

/** The memo the anchor told us to attach (SEP-24: hash memos are base64). */
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

/** `exp` of a JWT in ms; five minutes from now if it can't be read. */
export function jwtExpiresAt(token: string, now = Date.now()): number {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
    ) as { exp?: unknown };
    if (typeof payload.exp === 'number') return payload.exp * 1000;
  } catch {
    // not a readable JWT — fall through to the default
  }
  return now + 5 * 60_000;
}
