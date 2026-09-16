import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Asset, Horizon } from '@stellar/stellar-sdk';
import { setTimeout as sleep } from 'node:timers/promises';
import { Merchant } from '../generated/prisma/client';
import {
  AnchorAdapter,
  AnchorMerchantPatch,
  AnchorSettlementPatch,
  SettleResult,
  SettlementAnchorState,
} from './anchor.adapter';
import { AnchorHttpError, AnchorSession } from './anchor-session';
import {
  Sep12Customer,
  Sep6WithdrawResponse,
  anchorMemoFor,
  sep6Payout,
  sep6Phase,
} from './sep6';
import { AnchorInfo, TransferTransaction, withdrawBlock } from './transfer';
import { WithdrawPaymentDeps, sendWithdrawPayment } from './withdraw-payment';

// One settleToTRY call follows the anchor this long, then hands back `processing`; the
// settlement job resumes it every minute.
const FOLLOW_FOR_MS = 120_000;
const POLL_EVERY_MS = 3_000;
/** SEP-38 asset identifier for Turkish lira — how the anchor labels what it pays out. */
const TRY_ASSET = 'iso4217:TRY';

type Persist = (patch: AnchorSettlementPatch) => Promise<void>;
type PersistMerchant = (patch: AnchorMerchantPatch) => Promise<void>;

/**
 * The anchor refused the withdraw over its size. SEP-6 has no "quote first" step, so an anchor
 * whose real limits are stricter than its `/info` says (tr-mock-anchor advertises
 * `min_amount: 0.5` but enforces 1 USDC) only tells us here. Treated as a block, not a transient
 * error: nothing was opened, nothing was sent, and the minute job retries.
 */
function amountRejected(err: unknown): err is AnchorHttpError {
  return (
    err instanceof AnchorHttpError &&
    [400, 422].includes(err.status) &&
    /minimum|maximum|amount|limit|small|large/i.test(err.body)
  );
}

/**
 * USDC → TRY through a SEP-6 anchor (docs/anchor.md): SEP-1 stellar.toml → SEP-10 auth as the
 * merchant's own anchor user (platform key + merchant memo) → SEP-12 registration of the
 * merchant's IBAN → `GET /withdraw` → USDC payment to the account and memo it names → poll
 * `GET /transaction` until completed. Unlike SEP-24 there is no interactive page: the whole flow
 * is programmatic, so `interactiveUrl` is always null. Implemented against tr-mock-anchor.fly.dev.
 */
@Injectable()
export class Sep6AnchorAdapter implements AnchorAdapter {
  readonly name = 'sep6' as const;
  private readonly logger = new Logger(Sep6AnchorAdapter.name);
  private readonly horizon: Horizon.Server;
  private readonly networkPassphrase: string;
  private readonly usdc: Asset;

  constructor(
    config: ConfigService,
    private readonly session: AnchorSession,
  ) {
    this.horizon = new Horizon.Server(config.get<string>('HORIZON_URL')!);
    this.networkPassphrase = config.get<string>('NETWORK_PASSPHRASE')!;
    this.usdc = new Asset(
      config.get<string>('USDC_CODE')!,
      config.get<string>('USDC_ISSUER'),
    );
  }

  async settleToTRY(input: {
    settlement: SettlementAnchorState;
    merchant: Merchant;
    save: Persist;
    saveMerchant?: PersistMerchant;
  }): Promise<SettleResult> {
    const { merchant } = input;
    let state = { ...input.settlement };
    const persist: Persist = async (patch) => {
      await input.save(patch);
      state = { ...state, ...patch };
    };

    if (!state.anchorRef) {
      const blocked = await this.start(
        state,
        merchant,
        persist,
        input.saveMerchant,
      );
      if (blocked) return blocked;
    }
    const ref = state.anchorRef!;
    // Anchors scope transactions to the SEP-10 `sub`: poll as whoever opened it. Null = the bare
    // platform account, for a withdrawal opened before per-merchant identity.
    const memo = state.anchorMemo ?? undefined;

    const followUntil = Date.now() + FOLLOW_FOR_MS;
    for (;;) {
      const txn = await this.getTransaction(ref, memo);
      if (txn.status !== state.anchorStatus) {
        await persist({ anchorStatus: txn.status });
      }
      switch (sep6Phase(txn.status)) {
        case 'completed': {
          const payout = sep6Payout(txn, this.usdcAsset(), TRY_ASSET);
          if (!payout.ok) {
            // The anchor paid out, but nothing here can be credited honestly. Terminal: a retry
            // changes nothing and crediting the gross would overstate the payout.
            return {
              status: 'failed',
              ref,
              reason: 'unexpected_fee_asset',
              detail: `withdraw ${ref} ${payout.detail}`,
            };
          }
          this.checkPayoutIban(state, txn, merchant);
          return {
            status: 'completed',
            ref,
            feeUSDC: payout.feeUSDC,
            ...(payout.netTRY ? { netTRY: payout.netTRY } : {}),
          };
        }
        case 'failed':
          return {
            status: 'failed',
            ref,
            reason: 'anchor_status',
            detail: `anchor transaction ${txn.status}${txn.message ? `: ${txn.message}` : ''}`,
          };
        case 'send_funds': {
          const failed = await sendWithdrawPayment(
            this.deps(),
            state,
            txn,
            persist,
          );
          if (failed) return failed;
          break;
        }
        case 'interactive':
        case 'in_progress':
          break;
      }
      if (Date.now() >= followUntil) return { status: 'processing', ref };
      await sleep(POLL_EVERY_MS);
    }
  }

  payoutTRY(): Promise<{ ref: string }> {
    // The SEP-6 withdraw already pays the merchant at settlement time.
    return Promise.reject(
      new Error(
        'ANCHOR_PROVIDER=sep6 has no separate TRY payout: the anchor pays during settlement (docs/anchor.md)',
      ),
    );
  }

  /** Checks limits, registers the payout IBAN and opens the withdraw. Returns a result only when
   * blocked. */
  private async start(
    state: SettlementAnchorState,
    merchant: Merchant,
    persist: Persist,
    saveMerchant?: PersistMerchant,
  ): Promise<SettleResult | null> {
    if (!merchant.iban) {
      return {
        status: 'blocked',
        reason: 'missing_iban',
        detail: `merchant ${merchant.id} has no IBAN for the anchor payout`,
      };
    }
    const transferServer = await this.session.transferServer('sep6');
    const info = await this.session.request<AnchorInfo>(
      `${transferServer}/info`,
    );
    const block = withdrawBlock(info, this.usdc.getCode(), state.amountUSDC);
    if (block) return { status: 'blocked', ...block };

    const memo = anchorMemoFor(merchant.id);
    const token = await this.session.token(memo);
    const rejected = await this.ensureCustomer(
      merchant as Merchant & { iban: string },
      token,
      saveMerchant,
    );
    if (rejected) return rejected;

    const query = new URLSearchParams({
      asset_code: this.usdc.getCode(),
      // `type` is deprecated in SEP-6; tr-mock-anchor still accepts it, but not every anchor will.
      funding_method: 'bank_account',
      amount: state.amountUSDC.toFixed(7),
      account: this.session.account(),
      dest: merchant.iban,
    });
    let res: Sep6WithdrawResponse;
    try {
      res = await this.session.request<Sep6WithdrawResponse>(
        `${transferServer}/withdraw?${query.toString()}`,
        { token },
      );
    } catch (err) {
      if (!amountRejected(err)) throw err;
      return {
        status: 'blocked',
        reason: 'outside_anchor_limits',
        detail: `anchor refused ${state.amountUSDC.toFixed(7)} ${this.usdc.getCode()}: ${err.body.slice(0, 200)}`,
      };
    }

    // The memo is saved with the ref: this transaction is only visible to that anchor user.
    await persist({ anchorRef: res.id, anchorMemo: memo });
    this.logger.log(
      `Settlement ${state.id}: SEP-6 withdraw ${res.id} opened on ${this.session.homeDomain} as anchor user ${memo} ` +
        `for ${state.amountUSDC.toFixed(7)} ${this.usdc.getCode()} → ${res.account_id} (memo ${res.memo_type} ${res.memo})`,
    );
    return null;
  }

  /**
   * SEP-12: tells the anchor which IBAN pays this merchant — without it the anchor pays a sandbox
   * default account, not the merchant. Registered (PUT) when nothing is on record for this IBAN
   * and home domain, i.e. the first withdraw and after every IBAN change. Otherwise one GET
   * confirms the anchor still has the customer accepted — a sandbox reset forgets it, and would
   * silently route the payout to the default account again. Returns a block only when the anchor
   * rejects the IBAN itself (400: tr-mock-anchor validates a Turkish mod-97 IBAN).
   */
  private async ensureCustomer(
    merchant: Merchant & { iban: string },
    token: string,
    saveMerchant?: PersistMerchant,
  ): Promise<SettleResult | null> {
    const { kycServer } = await this.session.endpoints();
    if (!kycServer) {
      throw new Error(
        `${this.session.homeDomain} stellar.toml has no KYC_SERVER — the payout IBAN can't be registered`,
      );
    }
    const homeDomain = this.session.homeDomain;
    const onRecord =
      merchant.sep12CustomerId !== null &&
      merchant.sep12Iban === merchant.iban &&
      merchant.sep12HomeDomain === homeDomain;
    if (onRecord) {
      const customer = await this.session.request<Sep12Customer>(
        `${kycServer}/customer`,
        { token },
      );
      if (
        customer.status === 'ACCEPTED' &&
        customer.id === merchant.sep12CustomerId
      ) {
        return null;
      }
      this.logger.warn(
        `Merchant ${merchant.id}: anchor customer ${merchant.sep12CustomerId} is now ${customer.status ?? 'unknown'} ` +
          `(id ${customer.id ?? 'none'}) on ${homeDomain} — registering the IBAN again`,
      );
    }

    let registered: Sep12Customer;
    try {
      registered = await this.session.request<Sep12Customer>(
        `${kycServer}/customer`,
        {
          method: 'PUT',
          token,
          body: { bank_account_number: merchant.iban },
        },
      );
    } catch (err) {
      if (err instanceof AnchorHttpError && err.status === 400) {
        return {
          status: 'blocked',
          reason: 'missing_iban',
          detail: `anchor rejected merchant ${merchant.id}'s IBAN: ${err.body.slice(0, 200)}`,
        };
      }
      throw err;
    }
    if (!registered.id) {
      throw new Error(
        `${homeDomain} SEP-12 PUT /customer returned no id for merchant ${merchant.id}`,
      );
    }
    const patch: AnchorMerchantPatch = {
      sep12CustomerId: registered.id,
      sep12Iban: merchant.iban,
      sep12HomeDomain: homeDomain,
    };
    await saveMerchant?.(patch);
    Object.assign(merchant, patch);
    this.logger.log(
      `Merchant ${merchant.id}: payout IBAN registered with ${homeDomain} as SEP-12 customer ${registered.id}`,
    );
    return null;
  }

  /** The anchor already paid out, so a wrong IBAN can't fail the settlement — but it must be loud. */
  private checkPayoutIban(
    state: SettlementAnchorState,
    txn: TransferTransaction,
    merchant: Merchant,
  ): void {
    const bankRef = txn.external_transaction_id ?? 'none';
    if (txn.to && merchant.iban && txn.to !== merchant.iban) {
      this.logger.error(
        `Settlement ${state.id}: anchor paid ${txn.to}, not merchant ${merchant.id}'s IBAN ${merchant.iban} ` +
          `(bank ref ${bankRef}) — reconcile by hand`,
      );
      return;
    }
    this.logger.log(
      `Settlement ${state.id}: anchor paid ${txn.to ?? 'an unreported account'} (bank ref ${bankRef})`,
    );
  }

  private async getTransaction(
    id: string,
    memo?: string,
  ): Promise<TransferTransaction> {
    const transferServer = await this.session.transferServer('sep6');
    const { transaction } = await this.session.request<{
      transaction: TransferTransaction;
    }>(`${transferServer}/transaction?${new URLSearchParams({ id })}`, {
      token: await this.session.token(memo),
    });
    return transaction;
  }

  private usdcAsset(): string {
    return `stellar:${this.usdc.getCode()}:${this.usdc.getIssuer()}`;
  }

  private deps(): WithdrawPaymentDeps {
    return {
      session: this.session,
      horizon: this.horizon,
      networkPassphrase: this.networkPassphrase,
      usdc: this.usdc,
      logger: this.logger,
    };
  }
}
