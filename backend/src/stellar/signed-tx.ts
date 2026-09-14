import { Horizon, Transaction } from '@stellar/stellar-sdk';

/**
 * Signed-then-submit helpers for payments out of the platform account. The caller persists the
 * signed XDR + hash BEFORE submitting; a retry resubmits that same transaction (same sequence
 * number — it lands at most once) and only gives up on it once it provably never landed.
 */

/** The transaction on Horizon, or null when Horizon has never seen it (404). */
export async function findTransaction(
  horizon: Horizon.Server,
  hash: string,
): Promise<{ successful: boolean } | null> {
  try {
    return await horizon.transactions().transaction(hash).call();
  } catch (err) {
    if (httpStatus(err) === 404) return null;
    throw err;
  }
}

/** True once a ledger has closed after the transaction's maxTime — it can never be included. */
export async function expired(
  horizon: Horizon.Server,
  tx: Transaction,
): Promise<boolean> {
  const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
  if (!maxTime) return false;
  const { records } = await horizon.ledgers().order('desc').limit(1).call();
  return Date.parse(records[0].closed_at) / 1000 > maxTime;
}

/** Submits a signed transaction. A failed submit whose transaction did land (e.g. a timeout after
 * inclusion) counts as success; anything else throws with Horizon's result codes. */
export async function submitSigned(
  horizon: Horizon.Server,
  tx: Transaction,
): Promise<void> {
  const hash = tx.hash().toString('hex');
  try {
    await horizon.submitTransaction(tx);
  } catch (err) {
    if ((await findTransaction(horizon, hash))?.successful) return;
    throw new Error(
      `payment ${hash} submission failed: ${JSON.stringify(horizonResultCodes(err))}`,
    );
  }
}

export function httpStatus(err: unknown): number | undefined {
  const response = (err as { response?: { status?: number } })?.response;
  return response?.status;
}

export function horizonResultCodes(err: unknown): unknown {
  const data = (
    err as { response?: { data?: { extras?: { result_codes?: unknown } } } }
  )?.response?.data;
  return data?.extras?.result_codes ?? String(err);
}
