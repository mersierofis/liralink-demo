import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Asset, Horizon } from '@stellar/stellar-sdk';
import { setTimeout as sleep } from 'node:timers/promises';
import { Merchant } from '../generated/prisma/client';
import {
  AnchorAdapter,
  AnchorSettlementPatch,
  SettleResult,
  SettlementAnchorState,
} from './anchor.adapter';
import { AnchorHttpError, AnchorSession } from './anchor-session';
import { Sep6WithdrawResponse, sep6Payout, sep6Phase } from './sep6';
import { AnchorInfo, TransferTransaction, withdrawBlock } from './transfer';
import { WithdrawPaymentDeps, sendWithdrawPayment } from './withdraw-payment';

// One settleToTRY call follows the anchor this long, then hands back `processing`; the
// settlement job resumes it every minute.
const FOLLOW_FOR_MS = 120_000;
const POLL_EVERY_MS = 3_000;
/** SEP-38 asset identifier for Turkish lira — how the anchor labels what it pays out. */
const TRY_ASSET = 'iso4217:TRY';

type Persist = (patch: AnchorSettlementPatch) => Promise<void>;

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
 * USDC → TRY through a SEP-6 anchor (docs/anchor.md): SEP-1 stellar.toml → SEP-10 auth with the
 * platform key → `GET /withdraw` → USDC payment to the account and memo it names → poll
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
  }): Promise<SettleResult> {
    const { merchant } = input;
    let state = { ...input.settlement };
    const persist: Persist = async (patch) => {
      await input.save(patch);
      state = { ...state, ...patch };
    };

    if (!state.anchorRef) {
      const blocked = await this.start(state, merchant, persist);
      if (blocked) return blocked;
    }
    const ref = state.anchorRef!;

    const followUntil = Date.now() + FOLLOW_FOR_MS;
    for (;;) {
      const txn = await this.getTransaction(ref);
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

  /** Checks limits and opens the withdraw. Returns a result only when blocked. */
  private async start(
    state: SettlementAnchorState,
    merchant: Merchant,
    persist: Persist,
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

    const query = new URLSearchParams({
      asset_code: this.usdc.getCode(),
      type: 'bank_account',
      amount: state.amountUSDC.toFixed(7),
      account: this.session.account(),
      dest: merchant.iban,
    });
    let res: Sep6WithdrawResponse;
    try {
      res = await this.session.request<Sep6WithdrawResponse>(
        `${transferServer}/withdraw?${query}`,
        { token: await this.session.token() },
      );
    } catch (err) {
      if (!amountRejected(err)) throw err;
      return {
        status: 'blocked',
        reason: 'outside_anchor_limits',
        detail: `anchor refused ${state.amountUSDC.toFixed(7)} ${this.usdc.getCode()}: ${err.body.slice(0, 200)}`,
      };
    }

    await persist({ anchorRef: res.id });
    this.logger.log(
      `Settlement ${state.id}: SEP-6 withdraw ${res.id} opened on ${this.session.homeDomain} ` +
        `for ${state.amountUSDC.toFixed(7)} ${this.usdc.getCode()} → ${res.account_id} (memo ${res.memo_type} ${res.memo})`,
    );
    return null;
  }

  private async getTransaction(id: string): Promise<TransferTransaction> {
    const transferServer = await this.session.transferServer('sep6');
    const { transaction } = await this.session.request<{
      transaction: TransferTransaction;
    }>(`${transferServer}/transaction?${new URLSearchParams({ id })}`, {
      token: await this.session.token(),
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
