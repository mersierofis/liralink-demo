import { Decimal } from '../common/decimal';
import { Merchant } from '../generated/prisma/client';

/** The adapter new settlements and withdrawals use (ANCHOR_PROVIDER). */
export const ANCHOR_ADAPTER = Symbol('ANCHOR_ADAPTER');
/** Every adapter available in this process, by name — a settlement always continues on the
 * provider it was created with, even after ANCHOR_PROVIDER changes. */
export const ANCHOR_ADAPTERS = Symbol('ANCHOR_ADAPTERS');

export type AnchorProviderName = 'mock' | 'sep24';

/**
 * How TRY reaches the merchant. `balance`: it accrues in availableTRY and is withdrawn manually.
 * `auto_payout`: the anchor pays the merchant's IBAN during settlement (docs/anchor.md).
 */
export type SettlementMode = 'balance' | 'auto_payout';

/** Providers whose completed settlements accrue to availableTRY; every other one pays out. */
export const BALANCE_MODE_PROVIDERS: string[] = ['mock'];

export function settlementModeFor(provider: string): SettlementMode {
  return BALANCE_MODE_PROVIDERS.includes(provider) ? 'balance' : 'auto_payout';
}

/** The persisted progress of one settlement, as the adapter sees it. */
export interface SettlementAnchorState {
  id: string;
  amountUSDC: Decimal;
  anchorRef: string | null;
  interactiveUrl: string | null;
  anchorStatus: string | null;
  anchorTxHash: string | null;
  anchorTxXdr: string | null;
}

export type AnchorSettlementPatch = Partial<
  Pick<
    SettlementAnchorState,
    | 'anchorRef'
    | 'interactiveUrl'
    | 'anchorStatus'
    | 'anchorTxHash'
    | 'anchorTxXdr'
  >
>;

export type SettleResult =
  /** feeUSDC: what the anchor kept of amountUSDC — netTRY is derived from it. */
  | { status: 'completed'; ref: string; feeUSDC: Decimal }
  /** Started and not finished yet — the minute job calls settleToTRY again to resume. */
  | { status: 'processing'; ref: string }
  /** Can't start yet (nothing sent); stays `pending` with this reason and is retried. */
  | { status: 'blocked'; reason: BlockedReason; detail: string }
  /** Terminal — never retried. `detail` goes to the ERROR log. */
  | {
      status: 'failed';
      ref?: string;
      reason: SettleFailReason;
      detail: string;
    };

export type BlockedReason =
  'outside_anchor_limits' | 'missing_iban' | 'anchor_withdraw_disabled';

/** Settlement.failReason (docs/anchor.md). The adapter reports all but `invalid_fee`, which
 * SettlementsService sets when the reported fee can't be netted. */
export type SettleFailReason =
  'unexpected_fee_asset' | 'invalid_fee' | 'anchor_status' | 'amount_mismatch';

/** USDC → TRY settlement and TRY payout to an IBAN (docs/anchor.md). */
export interface AnchorAdapter {
  readonly name: AnchorProviderName;
  /**
   * Starts or resumes the settlement. Must be safe to call repeatedly: progress is persisted
   * through `save` before any irreversible step, and a call with `anchorRef` set resumes.
   */
  settleToTRY(input: {
    settlement: SettlementAnchorState;
    merchant: Merchant;
    save: (patch: AnchorSettlementPatch) => Promise<void>;
  }): Promise<SettleResult>;
  payoutTRY(input: {
    withdrawalId: string;
    amountTRY: Decimal;
    iban: string;
  }): Promise<{ ref: string }>;
}
