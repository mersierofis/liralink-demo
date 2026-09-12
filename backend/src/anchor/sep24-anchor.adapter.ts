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
import {
  AnchorAdapter,
  AnchorSettlementPatch,
  SettleResult,
  SettlementAnchorState,
} from './anchor.adapter';
import {
  jwtExpiresAt,
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

interface Endpoints {
  transferServer: string;
  authEndpoint: string;
  signingKey: string;
}

type Persist = (patch: AnchorSettlementPatch) => Promise<void>;

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
      switch (sep24Phase(txn.status)) {
        case 'completed':
          return { status: 'completed', ref };
        case 'failed':
          return {
            status: 'failed',
            ref,
            reason: `anchor transaction ${txn.status}${txn.message ? `: ${txn.message}` : ''}`,
          };
        case 'interactive':
          if (!this.testKycUrl) {
            // A real anchor: the merchant completes KYC at interactiveUrl; resumed every minute.
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

    const res = await this.request<{ id: string; url: string }>(
      `${transferServer}/transactions/withdraw/interactive`,
      {
        method: 'POST',
        token: await this.token(),
        body: {
          asset_code: this.usdc.getCode(),
          asset_issuer: this.usdc.getIssuer(),
          account: this.keypair.publicKey(),
          amount: state.amountUSDC.toFixed(7),
          lang: 'en',
        },
      },
    );
    await persist({ anchorRef: res.id, interactiveUrl: res.url });
    this.logger.log(
      `Settlement ${state.id}: SEP-24 withdraw ${res.id} opened on ${this.homeDomain} for ${state.amountUSDC.toFixed(7)} USDC`,
    );
    return null;
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
      const onLedger = await this.findTransaction(state.anchorTxHash);
      if (onLedger?.successful) return null; // sent; waiting for the anchor to see it
      const saved = new Transaction(state.anchorTxXdr, this.networkPassphrase);
      if (!onLedger && !(await this.expired(saved))) {
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
        reason: `anchor expects ${txn.amount_in} USDC, settlement is ${state.amountUSDC.toFixed(7)} — nothing sent`,
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
    const hash = tx.hash().toString('hex');
    try {
      await this.horizon.submitTransaction(tx);
      this.logger.log(
        `Settlement ${state.id}: sent ${state.amountUSDC.toFixed(7)} USDC to anchor, tx ${hash}`,
      );
    } catch (err) {
      if ((await this.findTransaction(hash))?.successful) return;
      throw new Error(
        `payment ${hash} submission failed: ${JSON.stringify(horizonResultCodes(err))}`,
      );
    }
  }

  /** True once a ledger has closed after the transaction's maxTime — it can never be included. */
  private async expired(tx: Transaction): Promise<boolean> {
    const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
    if (!maxTime) return false;
    const { records } = await this.horizon
      .ledgers()
      .order('desc')
      .limit(1)
      .call();
    return Date.parse(records[0].closed_at) / 1000 > maxTime;
  }

  private async findTransaction(
    hash: string,
  ): Promise<{ successful: boolean } | null> {
    try {
      return await this.horizon.transactions().transaction(hash).call();
    } catch (err) {
      if (httpStatus(err) === 404) return null;
      throw err;
    }
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
    if (this.endpoints) return this.endpoints;
    if (!this.homeDomain) {
      throw new Error(
        'ANCHOR_HOME_DOMAIN is required for ANCHOR_PROVIDER=sep24',
      );
    }
    const toml = await StellarToml.Resolver.resolve(this.homeDomain);
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
    this.endpoints = {
      transferServer: transferServer.replace(/\/$/, ''),
      authEndpoint,
      signingKey,
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
    const challenge = await this.request<{ transaction: string }>(
      `${authEndpoint}?${new URLSearchParams({ account: this.keypair.publicKey(), home_domain: this.homeDomain })}`,
    );
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
    init: { method?: string; token?: string; body?: unknown } = {},
  ): Promise<T> {
    const method = init.method ?? 'GET';
    const headers: Record<string, string> = {};
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(url, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const text = await res.text();
    const path = new URL(url).pathname;
    if (!res.ok) {
      throw new Error(
        `${method} ${path} → ${res.status}: ${text.slice(0, 300)}`,
      );
    }
    return JSON.parse(text) as T;
  }
}

function httpStatus(err: unknown): number | undefined {
  const response = (err as { response?: { status?: number } })?.response;
  return response?.status;
}

function horizonResultCodes(err: unknown): unknown {
  const data = (
    err as { response?: { data?: { extras?: { result_codes?: unknown } } } }
  )?.response?.data;
  return data?.extras?.result_codes ?? String(err);
}
