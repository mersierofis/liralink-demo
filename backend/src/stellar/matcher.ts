import { Decimal } from '../common/decimal';

export type LinkStatusForMatch = 'open' | 'paid' | 'expired' | 'cancelled';

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
}

export interface MatchConfig {
  platformAddress: string;
  assetCode: string;
  assetIssuer: string;
}

export type MatchResult =
  | { kind: 'paid'; amountUSDC: Decimal }
  | { kind: 'underpaid'; amountUSDC: Decimal }
  | { kind: 'ignored'; reason: string };

/** Decodes a base64 memo payload into the uppercase link code it should represent. */
export function decodeMemoCode(memoBytes: string): string {
  return Buffer.from(memoBytes, 'base64').toString('utf8').trim().toUpperCase();
}

export function match(
  op: InboundOp,
  link: LinkForMatch | null,
  cfg: MatchConfig,
): MatchResult {
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
  if (op.memoType !== 'text' || !op.memoBytes) {
    return { kind: 'ignored', reason: 'missing or non-text memo' };
  }
  if (!link) return { kind: 'ignored', reason: 'no matching link for memo' };
  if (link.status !== 'open')
    return { kind: 'ignored', reason: `link status is "${link.status}"` };

  const amountUSDC = new Decimal(op.amount);
  if (amountUSDC.lessThan(link.quotedUSDC))
    return { kind: 'underpaid', amountUSDC };
  return { kind: 'paid', amountUSDC };
}
