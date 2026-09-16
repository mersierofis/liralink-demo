import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { setTimeout as sleep } from 'node:timers/promises';
import { Asset, Horizon } from '@stellar/stellar-sdk';
import { Merchant } from '../generated/prisma/client';
import {
  AnchorAdapter,
  AnchorSettlementPatch,
  SettleResult,
  SettlementAnchorState,
} from './anchor.adapter';
import {
  AnchorHttpError,
  AnchorRequestInit,
  AnchorSession,
  FormEncoding,
} from './anchor-session';
import { Sep24Info, Sep24Transaction, sep24FeeUSDC, sep24Phase } from './sep24';
import { withdrawBlock } from './transfer';
import { WithdrawPaymentDeps, sendWithdrawPayment } from './withdraw-payment';

// One settleToTRY call follows the anchor this long, then hands back `processing`; the
// settlement job resumes it every minute.
const FOLLOW_FOR_MS = 120_000;
const POLL_EVERY_MS = 3_000;

const OTHER_ENCODING: Record<FormEncoding, FormEncoding> = {
  multipart: 'urlencoded',
  urlencoded: 'multipart',
};

type Persist = (patch: AnchorSettlementPatch) => Promise<void>;

/** The anchor did not understand the body's format: 400/415/422, or a 5xx whose body names the
 * content type (testanchor answers an unsupported one with 500). Worth one try in the other format. */
function formatRejected(err: unknown): err is AnchorHttpError {
  if (!(err instanceof AnchorHttpError)) return false;
  if ([400, 415, 422].includes(err.status)) return true;
  return err.status >= 500 && /content-type/i.test(err.body);
}

/**
 * USDC → fiat through a SEP-24 anchor (docs/anchor.md): SEP-1 stellar.toml → SEP-10 auth with the
 * platform key → interactive withdraw → USDC payment to the anchor's account + memo → poll
 * until the anchor completes. Implemented against testanchor.stellar.org.
 */
@Injectable()
export class Sep24AnchorAdapter implements AnchorAdapter {
  readonly name = 'sep24' as const;
  private readonly logger = new Logger(Sep24AnchorAdapter.name);
  private readonly testKycUrl: string;
  private readonly horizon: Horizon.Server;
  private readonly networkPassphrase: string;
  private readonly usdc: Asset;
  private readonly kycSubmitted = new Set<string>();
  // ANCHOR_SEP24_ENCODING; switched for this process once the anchor rejects it and takes the other.
  private withdrawEncoding: FormEncoding;

  constructor(
    config: ConfigService,
    private readonly session: AnchorSession,
  ) {
    this.testKycUrl = (
      config.get<string>('ANCHOR_SEP24_TEST_KYC_URL') ?? ''
    ).replace(/\/$/, '');
    this.withdrawEncoding =
      config.get<FormEncoding>('ANCHOR_SEP24_ENCODING') ?? 'multipart';
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
        if (sep24Phase(txn.status) === 'interactive' && !this.testKycUrl) {
          this.logger.log(
            `Settlement ${state.id}: withdraw ${ref} waits for the merchant to complete interactiveUrl`,
          );
        }
      }
      switch (sep24Phase(txn.status)) {
        case 'completed': {
          const usdcAsset = `stellar:${this.usdc.getCode()}:${this.usdc.getIssuer()}`;
          const feeUSDC = sep24FeeUSDC(txn, usdcAsset);
          if (!feeUSDC) {
            // The anchor paid out, but a fee in another asset can't be netted against the USDC.
            // Terminal: crediting the gross would overstate the payout, and a retry changes nothing.
            return {
              status: 'failed',
              ref,
              reason: 'unexpected_fee_asset',
              detail: `withdraw ${ref} completed with its fee in ${JSON.stringify(txn.fee_details ?? { amount_fee: txn.amount_fee, amount_fee_asset: txn.amount_fee_asset })}, not ${usdcAsset}`,
            };
          }
          return { status: 'completed', ref, feeUSDC };
        }
        case 'failed':
          return {
            status: 'failed',
            ref,
            reason: 'anchor_status',
            detail: `anchor transaction ${txn.status}${txn.message ? `: ${txn.message}` : ''}`,
          };
        case 'interactive':
          if (!this.testKycUrl) {
            // A real anchor: the merchant completes KYC at interactiveUrl (exposed while
            // anchorStatus is incomplete). Nothing to do until then — the minute job checks once
            // per run and resumes as soon as the anchor moves on. Not an error, never a failure.
            return { status: 'processing', ref };
          }
          await this.submitTestKyc(state, merchant);
          break;
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
        case 'in_progress':
          break;
      }
      if (Date.now() >= followUntil) return { status: 'processing', ref };
      await sleep(POLL_EVERY_MS);
    }
  }

  payoutTRY(): Promise<{ ref: string }> {
    // The SEP-24 withdraw already pays the merchant's IBAN at settlement time.
    return Promise.reject(
      new Error(
        'ANCHOR_PROVIDER=sep24 has no separate TRY payout: the anchor pays the IBAN during settlement (docs/anchor.md)',
      ),
    );
  }

  /** Checks limits and opens the interactive withdraw. Returns a result only when blocked. */
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
    const { transferServer } = await this.getEndpoints();
    const info = await this.request<Sep24Info>(`${transferServer}/info`);
    const block = withdrawBlock(info, this.usdc.getCode(), state.amountUSDC);
    if (block) return { status: 'blocked', ...block };

    const res = await this.openWithdraw(
      `${transferServer}/transactions/withdraw/interactive`,
      {
        asset_code: this.usdc.getCode(),
        asset_issuer: this.usdc.getIssuer()!,
        account: this.session.account(),
        amount: state.amountUSDC.toFixed(7),
        lang: 'en',
      },
    );
    await persist({ anchorRef: res.id, interactiveUrl: res.url });
    this.logger.log(
      `Settlement ${state.id}: SEP-24 withdraw ${res.id} opened on ${this.session.homeDomain} (${this.withdrawEncoding}) for ${state.amountUSDC.toFixed(7)} USDC`,
    );
    return null;
  }

  /** SEP-24 wants a form body, never JSON. ANCHOR_SEP24_ENCODING picks the format (default
   * multipart/form-data; the spec's example is urlencoded). If the anchor rejects that format
   * (formatRejected), the same fields go once in the other one — a rejected request opened nothing,
   * so the retry cannot open a second withdraw — and the format that worked is kept. */
  private async openWithdraw(
    url: string,
    fields: Record<string, string>,
  ): Promise<{ id: string; url: string }> {
    const token = await this.token();
    const post = (encoding: FormEncoding) =>
      this.request<{ id: string; url: string }>(url, {
        method: 'POST',
        token,
        form: { encoding, fields },
      });
    const first = this.withdrawEncoding;
    try {
      return await post(first);
    } catch (err) {
      if (!formatRejected(err)) throw err;
      const other = OTHER_ENCODING[first];
      this.logger.warn(
        `${this.session.homeDomain} rejected the ${first} withdraw body (${err.message}) — retrying ${other}`,
      );
      const res = await post(other);
      this.withdrawEncoding = other;
      return res;
    }
  }

  /** testanchor only: posts the interactive form (KYC + bank details) to its reference server,
   * the same two calls its web UI makes. */
  private async submitTestKyc(
    state: SettlementAnchorState,
    merchant: Merchant,
  ): Promise<void> {
    const ref = state.anchorRef!;
    if (this.kycSubmitted.has(ref)) return;
    const interactiveToken = state.interactiveUrl
      ? new URL(state.interactiveUrl).searchParams.get('token')
      : null;
    if (!interactiveToken) {
      throw new Error(`withdraw ${ref}: interactiveUrl carries no token`);
    }
    const started = await this.request<{ sessionId?: string; msg?: string }>(
      `${this.testKycUrl}/start`,
      { method: 'POST', token: interactiveToken },
    );
    if (!started.sessionId) {
      throw new Error(`withdraw ${ref}: test KYC /start: ${started.msg}`);
    }
    const submitted = await this.request<{ sessionId?: string; msg?: string }>(
      `${this.testKycUrl}/submit`,
      {
        method: 'POST',
        token: started.sessionId,
        body: {
          amount: state.amountUSDC.toFixed(7),
          name: merchant.businessName,
          surname: 'LiraLink',
          email: merchant.email,
          bank: 'IBAN',
          account: merchant.iban,
        },
      },
    );
    if (!submitted.sessionId) {
      throw new Error(`withdraw ${ref}: test KYC /submit: ${submitted.msg}`);
    }
    this.kycSubmitted.add(ref);
    this.logger.log(`Settlement ${state.id}: test KYC submitted for ${ref}`);
  }

  private async getTransaction(id: string): Promise<Sep24Transaction> {
    const { transferServer } = await this.getEndpoints();
    const { transaction } = await this.request<{
      transaction: Sep24Transaction;
    }>(`${transferServer}/transaction?${new URLSearchParams({ id })}`, {
      token: await this.token(),
    });
    return transaction;
  }

  /** SEP-1 discovery, SEP-10 auth and anchor HTTP live in AnchorSession, shared with SEP-6. */
  private async getEndpoints(): Promise<{ transferServer: string }> {
    return { transferServer: await this.session.transferServer('sep24') };
  }

  private token(): Promise<string> {
    return this.session.token();
  }

  private request<T>(url: string, init: AnchorRequestInit = {}): Promise<T> {
    return this.session.request<T>(url, init);
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
