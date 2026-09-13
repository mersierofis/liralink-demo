import { Decimal } from '../common/decimal';

export type LinkStatusForMatch =
  'open' | 'underpaid' | 'paid' | 'expired' | 'cancelled';

/** Decoupled from the Stellar SDK's own types on purpose — the SDK has shipped
 * four majors in thirteen months; an anti-corruption layer here keeps the
 * matcher (and its fixtures) stable across SDK upgrades. */
export interface InboundOp {
  opId: string;
  txHash: string;
  from: string;
  to: string;
  assetType: string;
  assetCode?: string;
  assetIssuer?: string;
  amount: string;
  memoType: string;
  memoBytes?: string; // base64, exact bytes — never the lossy UTF-8 `memo` field
  successful: boolean;
}

export interface LinkForMatch {
  code: string;
  status: LinkStatusForMatch;
  quotedUSDC: Decimal;
  /** Cumulative USDC already matched to this link (0 if never partially paid). */
  receivedUSDC: Decimal;
}

export interface MatchConfig {
  platformAddress: string;
  assetCode: string;
  assetIssuer: string;
}

export type MatchResult =
  // received (this op's amount + prior receivedUSDC) meets or exceeds quotedUSDC.
  // `excessUSDC` is 0 for an exact match, >0 for an overpayment — the caller
  // routes any excess to the merchant's unallocatedUSDC, never back into TRY.
  | {
      kind: 'paid';
      amountUSDC: Decimal;
      totalReceivedUSDC: Decimal;
      excessUSDC: Decimal;
    }
  // received stays below quotedUSDC — link stays open for a top-up payment.
  | {
      kind: 'underpaid';
      amountUSDC: Decimal;
      totalReceivedUSDC: Decimal;
      shortfallUSDC: Decimal;
    }
  // a valid USDC payment whose memo matches a real link that is no longer payable
  // (paid/expired/cancelled). The money still arrived at the platform, so the caller
  // records the attempt AND credits the amount to the link's merchant.unallocatedUSDC
  // (never auto-converted to TRY) — see PaymentsService.recordStray.
  | { kind: 'stray'; amountUSDC: Decimal; reason: string }
  | { kind: 'ignored'; reason: string };

/** Decodes a base64 memo payload into the uppercase link code it should represent. */
export function decodeMemoCode(memoBytes: string): string {
  return Buffer.from(memoBytes, 'base64').toString('utf8').trim().toUpperCase();
}

/** The success + destination + asset half of `match` — also used by the x402 rail, where the
 * link comes from the request URL (a Soroban transaction carries no memo). Null = acceptable. */
export function checkTransfer(
  op: InboundOp,
  cfg: MatchConfig,
): Extract<MatchResult, { kind: 'ignored' }> | null {
  if (!op.successful)
    return { kind: 'ignored', reason: 'transaction not successful' };
  if (op.to !== cfg.platformAddress)
    return { kind: 'ignored', reason: 'wrong destination' };
  if (
    op.assetType !== 'credit_alphanum4' ||
    op.assetCode !== cfg.assetCode ||
    op.assetIssuer !== cfg.assetIssuer
  ) {
    return { kind: 'ignored', reason: 'wrong asset' };
  }
  return null;
}

export function match(
  op: InboundOp,
  link: LinkForMatch | null,
  cfg: MatchConfig,
): MatchResult {
  const rejected = checkTransfer(op, cfg);
  if (rejected) return rejected;
  if (op.memoType !== 'text' || !op.memoBytes) {
    return { kind: 'ignored', reason: 'missing or non-text memo' };
  }
  if (!link) return { kind: 'ignored', reason: 'no matching link for memo' };
  return matchAmount(link, new Decimal(op.amount));
}

/** The link-status + amount half of `match` — also used by the contract rail, where the
 * invoice contract has already pinned destination and asset and there is no memo. */
export function matchAmount(
  link: LinkForMatch,
  amountUSDC: Decimal,
): MatchResult {
  if (link.status !== 'open' && link.status !== 'underpaid')
    return {
      kind: 'stray',
      amountUSDC,
      reason: `link status is "${link.status}"`,
    };

  const totalReceivedUSDC = link.receivedUSDC.plus(amountUSDC);

  if (totalReceivedUSDC.lessThan(link.quotedUSDC)) {
    return {
      kind: 'underpaid',
      amountUSDC,
      totalReceivedUSDC,
      shortfallUSDC: link.quotedUSDC.minus(totalReceivedUSDC),
    };
  }
  return {
    kind: 'paid',
    amountUSDC,
    totalReceivedUSDC,
    excessUSDC: totalReceivedUSDC.minus(link.quotedUSDC),
  };
}
