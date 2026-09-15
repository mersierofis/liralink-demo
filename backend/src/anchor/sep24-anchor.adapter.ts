import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Operation,
  StellarToml,
  Transaction,
  TransactionBuilder,
  WebAuth,
} from '@stellar/stellar-sdk';
import { Decimal } from '../common/decimal';
import { Merchant } from '../generated/prisma/client';
import { expired, findTransaction, submitSigned } from '../stellar/signed-tx';
import {
  AnchorAdapter,
  AnchorSettlementPatch,
  SettleResult,
  SettlementAnchorState,
} from './anchor.adapter';
import {
  jwtExpiresAt,
  sep24FeeUSDC,
  Sep24Info,
  sep24Phase,
  Sep24Transaction,
  withdrawBlock,
  withdrawMemo,
} from './sep24';

// One settleToTRY call follows the anchor this long, then hands back `processing`; the
// settlement job resumes it every minute.
const FOLLOW_FOR_MS = 120_000;
const POLL_EVERY_MS = 3_000;
const PAYMENT_TIMEOUT_S = 300;
const HTTP_TIMEOUT_MS = 20_000;
// stellar.toml is re-read this often, so a rotated SIGNING_KEY or moved endpoint needs no restart.
const TOML_TTL_MS = 60 * 60_000;

interface Endpoints {
  transferServer: string;
  authEndpoint: string;
  signingKey: string;
  fetchedAt: number;
}

type Persist = (patch: AnchorSettlementPatch) => Promise<void>;

type FormEncoding = 'multipart' | 'urlencoded';
// Statuses meaning "your multipart body was not understood" → the withdraw is retried urlencoded.
const FORM_REJECTED = new Set([400, 415, 422]);

/** A non-2xx anchor response; `status` tells a rejected request from a transient failure. */
class AnchorHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
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
  private readonly homeDomain: string;
  private readonly testKycUrl: string;
  private readonly keypair: Keypair;
  private readonly horizon: Horizon.Server;
  private readonly networkPassphrase: string;
  private readonly usdc: Asset;
  private endpoints: Endpoints | null = null;
  private jwt: { token: string; expiresAt: number } | null = null;
  private readonly kycSubmitted = new Set<string>();
  // multipart/form-data per SEP-24; switched for this process once the anchor rejects multipart.
  private withdrawEncoding: FormEncoding = 'multipart';

  constructor(config: ConfigService) {
    this.homeDomain = config.get<string>('ANCHOR_HOME_DOMAIN') ?? '';
    this.testKycUrl = (
      config.get<string>('ANCHOR_SEP24_TEST_KYC_URL') ?? ''
    ).replace(/\/$/, '');
    this.keypair = Keypair.fromSecret(
      config.get<string>('PLATFORM_ACCOUNT_SECRET')!,
    );
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
          const failed = await this.sendFunds(state, txn, persist);
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
        account: this.keypair.publicKey(),
        amount: state.amountUSDC.toFixed(7),
        lang: 'en',
      },
    );
    await persist({ anchorRef: res.id, interactiveUrl: res.url });
    this.logger.log(
      `Settlement ${state.id}: SEP-24 withdraw ${res.id} opened on ${this.homeDomain} (${this.withdrawEncoding}) for ${state.amountUSDC.toFixed(7)} USDC`,
    );
    return null;
  }

  /** SEP-24 wants a form body — multipart/form-data (its example is urlencoded), never JSON. If the
   * anchor rejects multipart (400/415/422), the same fields go urlencoded; a 4xx opened nothing, so
   * the retry cannot open a second withdraw. The encoding that worked is kept for later withdraws. */
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
    if (this.withdrawEncoding === 'urlencoded') return post('urlencoded');
    try {
      return await post('multipart');
    } catch (err) {
      if (!(err instanceof AnchorHttpError) || !FORM_REJECTED.has(err.status)) {
        throw err;
      }
      this.logger.warn(
        `${this.homeDomain} rejected the multipart withdraw body (${err.message}) — retrying urlencoded`,
      );
      const res = await post('urlencoded');
      this.withdrawEncoding = 'urlencoded';
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

  /**
   * Pays the anchor. The signed XDR is persisted before submitting, so a retry resubmits the
   * same transaction (same sequence number — it can land at most once). A new payment is built
   * only when the saved one provably never landed: not on Horizon and a ledger has closed after
   * its time bound. Returns a result only when the settlement must fail.
   */
  private async sendFunds(
    state: SettlementAnchorState,
    txn: Sep24Transaction,
    persist: Persist,
  ): Promise<SettleResult | null> {
    if (state.anchorTxXdr && state.anchorTxHash) {
      const onLedger = await findTransaction(this.horizon, state.anchorTxHash);
      if (onLedger?.successful) return null; // sent; waiting for the anchor to see it
      const saved = new Transaction(state.anchorTxXdr, this.networkPassphrase);
      if (!onLedger && !(await expired(this.horizon, saved))) {
        await this.submit(state, saved);
        return null;
      }
      this.logger.warn(
        `Settlement ${state.id}: payment ${state.anchorTxHash} ${onLedger ? 'failed on-ledger' : 'expired unsubmitted'} — building a new one`,
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

    const account = await this.horizon.loadAccount(this.keypair.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: txn.withdraw_anchor_account,
          asset: this.usdc,
          amount: state.amountUSDC.toFixed(7),
        }),
      )
      .addMemo(withdrawMemo(txn.withdraw_memo_type, txn.withdraw_memo))
      .setTimeout(PAYMENT_TIMEOUT_S)
      .build();
    tx.sign(this.keypair);
    await persist({
      anchorTxXdr: tx.toXDR(),
      anchorTxHash: tx.hash().toString('hex'),
    });
    await this.submit(state, tx);
    return null;
  }

  private async submit(
    state: SettlementAnchorState,
    tx: Transaction,
  ): Promise<void> {
    await submitSigned(this.horizon, tx);
    this.logger.log(
      `Settlement ${state.id}: sent ${state.amountUSDC.toFixed(7)} USDC to anchor, tx ${tx.hash().toString('hex')}`,
    );
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

  private async getEndpoints(): Promise<Endpoints> {
    if (this.endpoints && Date.now() - this.endpoints.fetchedAt < TOML_TTL_MS) {
      return this.endpoints;
    }
    if (!this.homeDomain) {
      throw new Error(
        'ANCHOR_HOME_DOMAIN is required for ANCHOR_PROVIDER=sep24',
      );
    }
    const toml = await StellarToml.Resolver.resolve(this.homeDomain, {
      timeout: HTTP_TIMEOUT_MS,
    });
    const transferServer = toml.TRANSFER_SERVER_SEP0024;
    const authEndpoint = toml.WEB_AUTH_ENDPOINT;
    const signingKey = toml.SIGNING_KEY;
    if (!transferServer || !authEndpoint || !signingKey) {
      throw new Error(
        `${this.homeDomain} stellar.toml lacks TRANSFER_SERVER_SEP0024, WEB_AUTH_ENDPOINT or SIGNING_KEY`,
      );
    }
    const anchorNetwork = toml.NETWORK_PASSPHRASE
      ? String(toml.NETWORK_PASSPHRASE)
      : null;
    if (anchorNetwork && anchorNetwork !== this.networkPassphrase) {
      throw new Error(
        `${this.homeDomain} is on "${toml.NETWORK_PASSPHRASE}", not "${this.networkPassphrase}"`,
      );
    }
    // A JWT issued under a rotated SIGNING_KEY is re-negotiated against the new one.
    if (this.endpoints && this.endpoints.signingKey !== signingKey) {
      this.jwt = null;
    }
    this.endpoints = {
      transferServer: transferServer.replace(/\/$/, ''),
      authEndpoint,
      signingKey,
      fetchedAt: Date.now(),
    };
    return this.endpoints;
  }

  /** SEP-10: the challenge is verified (anchor signature, home and web-auth domain, time bounds)
   * before the platform key signs it. */
  private async token(): Promise<string> {
    if (this.jwt && this.jwt.expiresAt > Date.now() + 60_000) {
      return this.jwt.token;
    }
    const { authEndpoint, signingKey } = await this.getEndpoints();
    const challenge = await this.request<{
      transaction: string;
      network_passphrase?: string;
    }>(
      `${authEndpoint}?${new URLSearchParams({ account: this.keypair.publicKey(), home_domain: this.homeDomain })}`,
    );
    // SEP-10: the challenge may name its network — never sign one meant for another network.
    if (
      challenge.network_passphrase &&
      challenge.network_passphrase !== this.networkPassphrase
    ) {
      throw new Error(
        `${this.homeDomain} SEP-10 challenge is for "${challenge.network_passphrase}", not "${this.networkPassphrase}"`,
      );
    }
    const { tx } = WebAuth.readChallengeTx(
      challenge.transaction,
      signingKey,
      this.networkPassphrase,
      this.homeDomain,
      new URL(authEndpoint).hostname,
    );
    tx.sign(this.keypair);
    const { token } = await this.request<{ token: string }>(authEndpoint, {
      method: 'POST',
      body: { transaction: tx.toXDR() },
    });
    this.jwt = { token, expiresAt: jwtExpiresAt(token) };
    return token;
  }

  private async request<T>(
    url: string,
    init: {
      method?: string;
      token?: string;
      body?: unknown;
      form?: { encoding: FormEncoding; fields: Record<string, string> };
    } = {},
  ): Promise<T> {
    const method = init.method ?? 'GET';
    const headers: Record<string, string> = {};
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    let body: string | FormData | URLSearchParams | undefined;
    if (init.form) {
      // No content-type header: fetch derives it from the body (with the multipart boundary).
      if (init.form.encoding === 'multipart') {
        body = new FormData();
        for (const [k, v] of Object.entries(init.form.fields))
          body.append(k, v);
      } else {
        body = new URLSearchParams(init.form.fields);
      }
    } else if (init.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const text = await res.text();
    const path = new URL(url).pathname;
    if (!res.ok) {
      // The anchor no longer accepts our JWT (revoked or expired early): re-authenticate next call.
      if (
        (res.status === 401 || res.status === 403) &&
        init.token !== undefined &&
        init.token === this.jwt?.token
      ) {
        this.jwt = null;
      }
      throw new AnchorHttpError(
        res.status,
        `${method} ${path} → ${res.status}: ${text.slice(0, 300)}`,
      );
    }
    return JSON.parse(text) as T;
  }
}
