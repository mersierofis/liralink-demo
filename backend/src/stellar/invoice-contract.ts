import { scValToNative, xdr } from '@stellar/stellar-sdk';
import { Decimal } from '../common/decimal';

/** Mirrors `Error` in contracts/invoice/src/lib.rs. */
export const INVOICE_ERROR = {
  AlreadyExists: 1,
  NotFound: 2,
  NotPending: 3,
  Expired: 4,
  InvalidAmount: 5,
} as const;

const STROOPS_PER_USDC = new Decimal(10_000_000);

// Testnet closes a ledger every ~5 s. Dividing by 6 puts the on-chain deadline a little
// before the link's `expiresAt`, so the contract never accepts a payment for a link the
// backend has already expired.
const CONSERVATIVE_LEDGER_SECONDS = 6;

export function usdcToStroops(amount: Decimal): bigint {
  const stroops = amount.times(STROOPS_PER_USDC);
  if (!stroops.isInteger()) {
    throw new Error(`USDC amount ${amount.toFixed()} has more than 7 decimals`);
  }
  return BigInt(stroops.toFixed(0));
}

export function stroopsToUsdc(stroops: bigint): Decimal {
  return new Decimal(stroops.toString()).div(STROOPS_PER_USDC);
}

export function deadlineLedgerFor(
  expiresAt: Date,
  now: Date,
  currentLedger: number,
): number {
  const secondsLeft = Math.floor((expiresAt.getTime() - now.getTime()) / 1000);
  return (
    currentLedger +
    Math.max(0, Math.floor(secondsLeft / CONSERVATIVE_LEDGER_SECONDS))
  );
}

export interface PaidEvent {
  code: string;
  payer: string;
  merchant: string;
  amountUSDC: Decimal;
}

/** Decodes a `["paid", code]` → `{ payer, merchant, amount }` contract event; null for anything else. */
export function parsePaidEvent(
  topic: xdr.ScVal[],
  value: xdr.ScVal,
): PaidEvent | null {
  if (topic.length !== 2 || scValToNative(topic[0]) !== 'paid') return null;
  const data = scValToNative(value) as Record<string, unknown> | null;
  if (
    !data ||
    typeof data.payer !== 'string' ||
    typeof data.merchant !== 'string' ||
    typeof data.amount !== 'bigint'
  ) {
    return null;
  }
  return {
    code: String(scValToNative(topic[1])),
    payer: data.payer,
    merchant: data.merchant,
    amountUSDC: stroopsToUsdc(data.amount),
  };
}

/** Extracts N from a simulation error such as `HostError: Error(Contract, #1)`. */
export function contractErrorCode(message: string): number | null {
  const m = /Error\(Contract, #(\d+)\)/.exec(message);
  return m ? Number(m[1]) : null;
}
