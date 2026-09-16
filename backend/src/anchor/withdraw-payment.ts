import { Logger } from '@nestjs/common';
import {
  Asset,
  BASE_FEE,
  Horizon,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { Operation } from '@stellar/stellar-sdk';
import { Decimal } from '../common/decimal';
import { expired, findTransaction, submitSigned } from '../stellar/signed-tx';
import {
  AnchorSettlementPatch,
  SettleResult,
  SettlementAnchorState,
} from './anchor.adapter';
import { AnchorSession } from './anchor-session';
import { TransferTransaction, withdrawMemo } from './transfer';

const PAYMENT_TIMEOUT_S = 300;

export interface WithdrawPaymentDeps {
  session: AnchorSession;
  horizon: Horizon.Server;
  networkPassphrase: string;
  usdc: Asset;
  logger: Logger;
}

/**
 * Pays the anchor for a withdraw that is waiting on our funds — identical for SEP-6 and SEP-24,
 * which describe the destination the same way (`withdraw_anchor_account` + `withdraw_memo` typed
 * by `withdraw_memo_type`).
 *
 * The signed XDR is persisted before submitting, so a retry resubmits the same transaction (same
 * sequence number — it can land at most once). A new payment is built only when the saved one
 * provably never landed: not on Horizon and a ledger has closed after its time bound. Returns a
 * result only when the settlement must fail.
 */
export async function sendWithdrawPayment(
  deps: WithdrawPaymentDeps,
  state: SettlementAnchorState,
  txn: TransferTransaction,
  persist: (patch: AnchorSettlementPatch) => Promise<void>,
): Promise<SettleResult | null> {
  const { session, horizon, networkPassphrase, usdc, logger } = deps;

  if (state.anchorTxXdr && state.anchorTxHash) {
    const onLedger = await findTransaction(horizon, state.anchorTxHash);
    if (onLedger?.successful) return null; // sent; waiting for the anchor to see it
    const saved = new Transaction(state.anchorTxXdr, networkPassphrase);
    if (!onLedger && !(await expired(horizon, saved))) {
      await submit(deps, state, saved);
      return null;
    }
    logger.warn(
      `Settlement ${state.id}: payment ${state.anchorTxHash} ${
        onLedger ? 'failed on-ledger' : 'expired unsubmitted'
      } — building a new one`,
    );
  }

  if (!txn.withdraw_anchor_account) {
    throw new Error(`withdraw ${txn.id}: no withdraw_anchor_account yet`);
  }
  if (txn.amount_in && !new Decimal(txn.amount_in).equals(state.amountUSDC)) {
    return {
      status: 'failed',
      ref: txn.id,
      reason: 'amount_mismatch',
      detail: `anchor expects ${txn.amount_in} USDC, settlement is ${state.amountUSDC.toFixed(7)} — nothing sent`,
    };
  }

  const account = await horizon.loadAccount(session.account());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: txn.withdraw_anchor_account,
        asset: usdc,
        amount: state.amountUSDC.toFixed(7),
      }),
    )
    .addMemo(withdrawMemo(txn.withdraw_memo_type, txn.withdraw_memo))
    .setTimeout(PAYMENT_TIMEOUT_S)
    .build();
  session.sign(tx);
  await persist({
    anchorTxXdr: tx.toXDR(),
    anchorTxHash: tx.hash().toString('hex'),
  });
  await submit(deps, state, tx);
  return null;
}

async function submit(
  { horizon, logger }: WithdrawPaymentDeps,
  state: SettlementAnchorState,
  tx: Transaction,
): Promise<void> {
  await submitSigned(horizon, tx);
  logger.log(
    `Settlement ${state.id}: sent ${state.amountUSDC.toFixed(7)} USDC to anchor, tx ${tx
      .hash()
      .toString('hex')}`,
  );
}
