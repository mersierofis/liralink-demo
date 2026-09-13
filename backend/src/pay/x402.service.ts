import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  FeeBumpTransaction,
  Horizon,
  Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http';
import {
  FacilitatorTimeoutError,
  x402ResourceServer,
  type FacilitatorClient,
} from '@x402/core/server';
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  ResourceInfo,
  SettleResponse,
} from '@x402/core/types';
import { ExactStellarScheme } from '@x402/stellar/exact/server';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Decimal } from '../common/decimal';
import { Prisma, X402Settlement } from '../generated/prisma/client';
import { PaymentResponseDto } from '../payments/dto/payment-response.dto';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  checkTransfer,
  InboundOp,
  MatchConfig,
  matchAmount,
} from '../stellar/matcher';
import { StellarService } from '../stellar/stellar.service';
import { PayService } from './pay.service';

/** The facilitator client, or null when x402 is disabled (see PayModule). */
export const X402_FACILITATOR = Symbol('X402_FACILITATOR');

// The x402.org facilitator serves stellar:testnet only — no pubnet entry in its /supported.
export const X402_NETWORK = 'stellar:testnet';
// Auth entries expire ~1 min after signing (latestLedger + 12); don't advertise longer.
const MAX_TIMEOUT_SECONDS = 60;
const USDC_UNITS = new Decimal(10_000_000);
// Horizon ingests the settled transaction a few seconds after the facilitator returns.
const HORIZON_CONFIRM_ATTEMPTS = 15;
const HORIZON_CONFIRM_DELAY_MS = 1_000;
// A pending settlement is failed only this long after its auth entries expired — by then a late
// settlement has long been ingested by Horizon, and the entries can no longer be submitted.
const PENDING_GRACE_MS = 2 * 60_000;
// How far back the reconcile job scans the platform account's payments for a late settlement.
const RECONCILE_SCAN_LIMIT = 200;

export interface AgentReceipt {
  code: string;
  linkStatus: string;
  rail: 'x402';
  network: string;
  facilitator: string;
  /** What the matcher made of the settled transfer: paid | underpaid | stray | ignored. */
  credit: string;
  reason?: string;
  settlement: SettleResponse;
  payment: PaymentResponseDto | null;
}

/** 202: the facilitator timed out settling — outcome unknown, reconciled by the minute job. */
export interface AgentPending {
  code: string;
  status: 'pending';
  x402SettlementId: string;
  rail: 'x402';
  network: string;
  facilitator: string;
}

export type AgentPayResult =
  | { status: 402; body: PaymentRequired; headers: Record<string, string> }
  | { status: 202; body: AgentPending; headers: Record<string, string> }
  | { status: 200; body: AgentReceipt; headers: Record<string, string> };

/**
 * x402 rail for `GET /pay/:code/agent` — lets an agent pay a link over HTTP 402. Verification and
 * settlement go through the x402.org facilitator (testnet only); the settled SAC transfer is then
 * read back from Horizon and credited through the same matcher as the other rails. A Soroban
 * transaction carries no memo, so the link is identified by the URL, not by a memo.
 */
@Injectable()
export class X402Service {
  private readonly logger = new Logger(X402Service.name);
  private readonly resourceServer: x402ResourceServer | null;
  private initializing: Promise<void> | null = null;
  private reconciling = false;
  private readonly usdcSac: string;
  private readonly networkPassphrase: string;
  private readonly matchConfig: MatchConfig;
  readonly facilitatorUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellarService: StellarService,
    private readonly paymentsService: PaymentsService,
    private readonly payService: PayService,
    config: ConfigService,
    @Inject(X402_FACILITATOR) facilitator: FacilitatorClient | null,
  ) {
    this.facilitatorUrl = config.get<string>('X402_FACILITATOR_URL')!;
    this.resourceServer = facilitator
      ? new x402ResourceServer(facilitator).register(
          X402_NETWORK,
          new ExactStellarScheme(),
        )
      : null;
    this.networkPassphrase = config.get<string>('NETWORK_PASSPHRASE')!;
    this.usdcSac = stellarService.usdcAsset.contractId(this.networkPassphrase);
    this.matchConfig = {
      platformAddress: stellarService.platformPublicKey,
      assetCode: config.get<string>('USDC_CODE')!,
      assetIssuer: config.get<string>('USDC_ISSUER')!,
    };
  }

  async handle(
    code: string,
    paymentHeader: string | undefined,
    resourceUrl: string,
  ): Promise<AgentPayResult> {
    const server = await this.server();
    // Same lookup + re-quote-on-expiry as GET /pay/:code (404 for an unknown code).
    await this.payService.getQuote(code);
    const link = await this.prisma.paymentLink.findUniqueOrThrow({
      where: { code },
    });
    if (link.status !== 'open' && link.status !== 'underpaid') {
      throw new ConflictException(`Payment link is ${link.status}`);
    }

    const dueUSDC = link.quotedUSDC.minus(link.receivedUSDC);
    const [requirements] = await server.buildPaymentRequirements({
      scheme: 'exact',
      network: X402_NETWORK,
      payTo: this.matchConfig.platformAddress,
      price: {
        asset: this.usdcSac,
        amount: dueUSDC.times(USDC_UNITS).toFixed(0),
      },
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    });
    const resource: ResourceInfo = {
      url: resourceUrl,
      description: `LiraLink ${link.code}: ${link.title} (${link.amountTRY.toFixed(2)} TRY)`,
      mimeType: 'application/json',
    };
    if (!paymentHeader) return this.paymentRequired(requirements, resource);

    let payload: PaymentPayload;
    try {
      payload = decodePaymentSignatureHeader(paymentHeader);
    } catch {
      return this.paymentRequired(
        requirements,
        resource,
        'invalid_payment_header',
      );
    }
    const matched = server.findMatchingRequirements([requirements], payload);
    if (!matched) {
      // Typically a stale payment: the quote moved or a top-up changed the amount due.
      return this.paymentRequired(
        requirements,
        resource,
        'payment_requirements_mismatch',
      );
    }

    const verified = await server.verifyPayment(payload, matched);
    if (!verified.isValid) {
      return this.paymentRequired(
        requirements,
        resource,
        verified.invalidReason ?? 'verification_failed',
      );
    }

    let settlement: SettleResponse;
    try {
      settlement = await server.settlePayment(payload, matched);
    } catch (err) {
      if (err instanceof FacilitatorTimeoutError) {
        return this.pending(link.code, payload, matched, verified.payer, err);
      }
      this.logger.error(
        `x402 settle for ${link.code} failed`,
        err instanceof Error ? err.stack : String(err),
      );
      return this.paymentRequired(requirements, resource, 'settle_failed');
    }
    if (!settlement.success) {
      return this.paymentRequired(
        requirements,
        resource,
        settlement.errorReason ?? 'settle_failed',
      );
    }
    this.logger.log(
      `x402 settled ${link.code}: tx ${settlement.transaction} from ${settlement.payer ?? '?'}`,
    );

    const receipt = await this.credit(link.code, settlement);
    return {
      status: 200,
      body: receipt,
      headers: { 'PAYMENT-RESPONSE': encodePaymentResponseHeader(settlement) },
    };
  }

  /**
   * Resolves settlements whose facilitator call timed out. Each minute, per pending row: (1) look
   * for the transfer on Horizon — the facilitator may have settled after all; (2) otherwise, while
   * the auth entries are still valid, retry the settle; (3) once they have expired (plus a grace for
   * Horizon ingestion) with nothing on-chain, fail it — the payer's USDC never moved.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async reconcilePending(): Promise<void> {
    if (this.reconciling || !this.resourceServer) return;
    this.reconciling = true;
    try {
      const pending = await this.prisma.x402Settlement.findMany({
        where: { status: 'pending' },
        orderBy: { createdAt: 'asc' },
      });
      for (const row of pending) {
        try {
          await this.reconcileOne(row);
        } catch (err) {
          this.logger.error(
            `x402 settlement ${row.id} reconcile attempt failed, will retry`,
            err instanceof Error ? err.stack : String(err),
          );
        }
      }
    } finally {
      this.reconciling = false;
    }
  }

  private async reconcileOne(row: X402Settlement): Promise<void> {
    const found = await this.findLateSettlement(row);
    if (found) {
      await this.creditPending(row, {
        success: true,
        transaction: found,
        network: X402_NETWORK,
        payer: row.payer ?? undefined,
      });
      return;
    }

    const now = Date.now();
    if (now < row.expiresAt.getTime()) {
      const server = await this.server();
      await this.prisma.x402Settlement.update({
        where: { id: row.id },
        data: { attempts: { increment: 1 } },
      });
      let settlement: SettleResponse;
      try {
        settlement = await server.settlePayment(
          row.paymentPayload as unknown as PaymentPayload,
          row.requirements as unknown as PaymentRequirements,
        );
      } catch (err) {
        await this.prisma.x402Settlement.update({
          where: { id: row.id },
          data: { lastError: err instanceof Error ? err.message : String(err) },
        });
        return;
      }
      if (settlement.success) {
        await this.creditPending(row, settlement);
      } else {
        // e.g. the entries were already consumed by the timed-out call — the next scan finds it.
        await this.prisma.x402Settlement.update({
          where: { id: row.id },
          data: { lastError: settlement.errorReason ?? 'settle_failed' },
        });
      }
      return;
    }

    if (now > row.expiresAt.getTime() + PENDING_GRACE_MS) {
      await this.prisma.x402Settlement.update({
        where: { id: row.id },
        data: { status: 'failed', failReason: 'not_settled_before_expiry' },
      });
      this.logger.warn(
        `x402 settlement ${row.id} for ${row.linkCode} failed: auth entries expired, no transfer on-chain`,
      );
    }
  }

  private async creditPending(
    row: X402Settlement,
    settlement: SettleResponse,
  ): Promise<void> {
    try {
      await this.credit(row.linkCode, settlement);
    } catch (err) {
      // Already credited (e.g. by a concurrent request) — the settlement is done either way.
      if (!(err instanceof ConflictException)) throw err;
    }
    await this.prisma.x402Settlement.update({
      where: { id: row.id },
      data: { status: 'settled', txHash: settlement.transaction },
    });
    this.logger.log(
      `x402 settlement ${row.id} for ${row.linkCode} reconciled: tx ${settlement.transaction}`,
    );
  }

  /** The on-chain transaction carrying this row's payer-signed auth entries, if it landed. Never
   * matched by payer + amount: two stuck payments of the same amount from one payer would swap. An
   * already-credited match is returned too — credit() then 409s and the row is marked settled. */
  private async findLateSettlement(
    row: X402Settlement,
  ): Promise<string | null> {
    if (!row.authEntriesHash) return null;
    const horizon = this.stellarService.server;
    const page = await horizon
      .payments()
      .forAccount(this.matchConfig.platformAddress)
      .order('desc')
      .limit(RECONCILE_SCAN_LIMIT)
      .call();
    const since = row.createdAt.getTime() - MAX_TIMEOUT_SECONDS * 1_000;
    const candidates = new Set(
      page.records
        .filter(
          (r) =>
            r.type ===
              Horizon.HorizonApi.OperationResponseType.invokeHostFunction &&
            new Date(r.created_at).getTime() >= since,
        )
        .map((r) => r.transaction_hash),
    );
    for (const txHash of candidates) {
      const tx = await horizon.transactions().transaction(txHash).call();
      const envelope = TransactionBuilder.fromXDR(
        tx.envelope_xdr,
        this.networkPassphrase,
      );
      if (authEntriesHash(envelope) === row.authEntriesHash) return txHash;
    }
    return null;
  }

  private async pending(
    code: string,
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    payer: string | undefined,
    err: FacilitatorTimeoutError,
  ): Promise<AgentPayResult> {
    let authHash: string | null = null;
    try {
      authHash = authEntriesHash(
        new Transaction(
          (payload.payload as { transaction: string }).transaction,
          this.networkPassphrase,
        ),
      );
    } catch {
      // Verified payloads always parse; without a hash the row can only be retried or failed.
    }
    const row = await this.prisma.x402Settlement.create({
      data: {
        linkCode: code,
        payer: payer ?? null,
        authEntriesHash: authHash,
        amountUSDC: new Decimal(requirements.amount).div(USDC_UNITS),
        paymentPayload: payload as unknown as Prisma.InputJsonValue,
        requirements: requirements as unknown as Prisma.InputJsonValue,
        lastError: err.message,
        expiresAt: new Date(
          Date.now() + requirements.maxTimeoutSeconds * 1_000,
        ),
      },
    });
    this.logger.warn(
      `x402 settle for ${code} timed out — outcome unknown, x402 settlement ${row.id} pending (reconciled every minute)`,
    );
    return {
      status: 202,
      body: {
        code,
        status: 'pending',
        x402SettlementId: row.id,
        rail: 'x402',
        network: X402_NETWORK,
        facilitator: this.facilitatorUrl,
      },
      headers: {},
    };
  }

  /** Reads the settled transaction back from Horizon — the facilitator's word alone never
   * credits anything — and routes it through the matcher. A tx hash is credited once: a replay
   * is a 409. */
  private async credit(
    code: string,
    settlement: SettleResponse,
  ): Promise<AgentReceipt> {
    const txHash = settlement.transaction;
    const { tx, op } = await this.readTransfer(txHash);

    if (await this.paymentsService.markProcessed(`x402:${txHash}`)) {
      throw new ConflictException(
        `Transaction ${txHash} was already processed`,
      );
    }

    const link = await this.prisma.paymentLink.findUniqueOrThrow({
      where: { code },
    });
    const result =
      checkTransfer(op, this.matchConfig) ??
      matchAmount(link, new Decimal(op.amount));
    await this.paymentsService.recordMatch(
      result.kind === 'ignored' ? null : link,
      op,
      code,
      result,
      tx.ledger_attr,
      'x402',
    );

    const after = await this.prisma.paymentLink.findUniqueOrThrow({
      where: { code },
    });
    const payment = await this.prisma.payment.findUnique({
      where: { txHash },
    });
    return {
      code,
      linkStatus: after.status,
      rail: 'x402',
      network: X402_NETWORK,
      facilitator: this.facilitatorUrl,
      credit: result.kind,
      reason: 'reason' in result ? result.reason : undefined,
      settlement,
      payment: payment ? PaymentResponseDto.fromEntity(payment) : null,
    };
  }

  private async readTransfer(
    txHash: string,
  ): Promise<{ tx: Horizon.ServerApi.TransactionRecord; op: InboundOp }> {
    const horizon = this.stellarService.server;
    let tx: Horizon.ServerApi.TransactionRecord | null = null;
    for (let i = 0; i < HORIZON_CONFIRM_ATTEMPTS && !tx; i++) {
      try {
        tx = await horizon.transactions().transaction(txHash).call();
      } catch (err) {
        if (i === HORIZON_CONFIRM_ATTEMPTS - 1) throw err;
        await sleep(HORIZON_CONFIRM_DELAY_MS);
      }
    }
    const ops = await horizon.operations().forTransaction(txHash).call();
    const change = ops.records
      .flatMap((r) =>
        r.type === Horizon.HorizonApi.OperationResponseType.invokeHostFunction
          ? r.asset_balance_changes
          : [],
      )
      .find(
        (c) =>
          c.type === 'transfer' && c.to === this.matchConfig.platformAddress,
      );

    const op: InboundOp = {
      opId: `x402:${txHash}`,
      txHash,
      from: change?.from ?? '',
      to: change?.to ?? '',
      assetType: change?.asset_type ?? '',
      assetCode: change?.asset_code,
      assetIssuer: change?.asset_issuer,
      amount: change?.amount ?? '0',
      memoType: 'none',
      successful: tx!.successful,
    };
    return { tx: tx!, op };
  }

  private async paymentRequired(
    requirements: PaymentRequirements,
    resource: ResourceInfo,
    error?: string,
  ): Promise<AgentPayResult> {
    const server = await this.server();
    const body = await server.createPaymentRequiredResponse(
      [requirements],
      resource,
      error,
    );
    return {
      status: 402,
      body,
      headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(body) },
    };
  }

  /** The resource server, after it has loaded the facilitator's /supported kinds once. */
  private async server(): Promise<x402ResourceServer> {
    const server = this.resourceServer;
    if (!server) {
      throw new ServiceUnavailableException(
        'x402 is disabled (testnet with X402_FACILITATOR_URL only)',
      );
    }
    this.initializing ??= server.initialize().catch((err: unknown) => {
      this.initializing = null;
      throw err;
    });
    try {
      await this.initializing;
    } catch (err) {
      this.logger.error(
        `x402 facilitator ${this.facilitatorUrl} unavailable`,
        err instanceof Error ? err.stack : String(err),
      );
      throw new ServiceUnavailableException('x402 facilitator unavailable');
    }
    return server;
  }
}

/** sha256 over the XDR of the single invokeHostFunction op's auth entries — identical in the
 * payer's signed payload and in the facilitator's rebuilt (possibly fee-bumped) transaction. */
export function authEntriesHash(
  tx: Transaction | FeeBumpTransaction,
): string | null {
  const inner = tx instanceof FeeBumpTransaction ? tx.innerTransaction : tx;
  const [op] = inner.operations;
  if (inner.operations.length !== 1 || op.type !== 'invokeHostFunction') {
    return null;
  }
  const auth: xdr.SorobanAuthorizationEntry[] = op.auth ?? [];
  if (auth.length === 0) return null;
  const hash = createHash('sha256');
  for (const entry of auth) hash.update(entry.toXDR());
  return hash.digest('hex');
}
