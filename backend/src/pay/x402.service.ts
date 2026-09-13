import {
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Horizon } from '@stellar/stellar-sdk';
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http';
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  ResourceInfo,
  SettleResponse,
} from '@x402/core/types';
import { ExactStellarScheme } from '@x402/stellar/exact/server';
import { setTimeout as sleep } from 'node:timers/promises';
import { Decimal } from '../common/decimal';
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

// The x402.org facilitator serves stellar:testnet only — no pubnet entry in its /supported.
const X402_NETWORK = 'stellar:testnet';
// Auth entries expire ~1 min after signing (latestLedger + 12); don't advertise longer.
const MAX_TIMEOUT_SECONDS = 60;
const USDC_UNITS = new Decimal(10_000_000);
// Horizon ingests the settled transaction a few seconds after the facilitator returns.
const HORIZON_CONFIRM_ATTEMPTS = 15;
const HORIZON_CONFIRM_DELAY_MS = 1_000;

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

export type AgentPayResult =
  | { status: 402; body: PaymentRequired; headers: Record<string, string> }
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
  private readonly usdcSac: string;
  private readonly matchConfig: MatchConfig;
  readonly facilitatorUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellarService: StellarService,
    private readonly paymentsService: PaymentsService,
    private readonly payService: PayService,
    config: ConfigService,
  ) {
    this.facilitatorUrl = config.get<string>('X402_FACILITATOR_URL')!;
    const enabled =
      this.facilitatorUrl !== '' &&
      config.get<string>('STELLAR_NETWORK') === 'testnet';
    this.resourceServer = enabled
      ? new x402ResourceServer(
          new HTTPFacilitatorClient({ url: this.facilitatorUrl }),
        ).register(X402_NETWORK, new ExactStellarScheme())
      : null;
    this.usdcSac = stellarService.usdcAsset.contractId(
      config.get<string>('NETWORK_PASSPHRASE')!,
    );
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
      this.logger.error(
        `x402 settle for ${link.code} threw (outcome unknown — check the payer's account)`,
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

  /** Reads the settled transaction back from Horizon — the facilitator's word alone never
   * credits anything — and routes it through the matcher. Idempotent on the tx hash. */
  private async credit(
    code: string,
    settlement: SettleResponse,
  ): Promise<AgentReceipt> {
    const txHash = settlement.transaction;
    const { tx, op } = await this.readTransfer(txHash);
    const receipt = (
      credit: string,
      linkStatus: string,
      reason?: string,
    ): AgentReceipt => ({
      code,
      linkStatus,
      rail: 'x402',
      network: X402_NETWORK,
      facilitator: this.facilitatorUrl,
      credit,
      reason,
      settlement,
      payment: null,
    });

    const opId = `x402:${txHash}`;
    if (await this.paymentsService.markProcessed(opId)) {
      const link = await this.prisma.paymentLink.findUniqueOrThrow({
        where: { code },
      });
      return receipt('already_processed', link.status);
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
      ...receipt(
        result.kind,
        after.status,
        'reason' in result ? result.reason : undefined,
      ),
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

  private paymentRequired(
    requirements: PaymentRequirements,
    resource: ResourceInfo,
    error?: string,
  ): Promise<AgentPayResult> {
    return this.server()
      .then((server) =>
        server.createPaymentRequiredResponse([requirements], resource, error),
      )
      .then((body) => ({
        status: 402 as const,
        body,
        headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(body) },
      }));
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
