import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  nativeToScVal,
  rpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { Decimal } from '../common/decimal';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  contractErrorCode,
  deadlineLedgerFor,
  INVOICE_ERROR,
  parsePaidEvent,
  stroopsToUsdc,
  usdcToStroops,
} from './invoice-contract';
import { InboundOp, matchAmount, MatchResult } from './matcher';

const POLL_INTERVAL_MS = 5_000;
const EVENTS_PAGE_LIMIT = 100;

export class InvoiceContractError extends Error {
  constructor(
    readonly contractCode: number | null,
    message: string,
  ) {
    super(message);
  }
}

export interface OnchainInvoice {
  txHash: string | null;
  amountUSDC: Decimal;
  deadlineLedger: number;
}

/**
 * The Soroban invoice rail (contracts/invoice). The platform account is the contract admin:
 * it creates/cancels invoices, and every invoice pays out to the platform account itself
 * (custodial — merchants never hold keys). Payments are detected by polling RPC `getEvents`
 * for `["paid", code]` and fed through the same matcher/PaymentsService as the memo rail.
 */
@Injectable()
export class InvoiceContractService {
  private readonly logger = new Logger(InvoiceContractService.name);
  private readonly server: rpc.Server;
  private readonly keypair: Keypair;
  private readonly networkPassphrase: string;
  private readonly assetCode: string;
  private readonly assetIssuer: string;
  readonly contractId: string | null;
  private polling = false;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly paymentsService: PaymentsService,
  ) {
    this.server = new rpc.Server(config.get<string>('RPC_URL')!);
    this.keypair = Keypair.fromSecret(
      config.get<string>('PLATFORM_ACCOUNT_SECRET')!,
    );
    this.networkPassphrase = config.get<string>('NETWORK_PASSPHRASE')!;
    this.assetCode = config.get<string>('USDC_CODE')!;
    this.assetIssuer = config.get<string>('USDC_ISSUER')!;
    this.contractId = config.get<string>('INVOICE_CONTRACT_ID') || null;
  }

  get enabled(): boolean {
    return this.contractId !== null;
  }

  /** Records `code` on-chain, payable to the platform account until `expiresAt`. If the invoice
   * already exists (a retry after a lost response), it is read back instead of failing. */
  async createInvoice(
    code: string,
    amountUSDC: Decimal,
    expiresAt: Date,
  ): Promise<OnchainInvoice> {
    const { sequence } = await this.server.getLatestLedger();
    const deadlineLedger = deadlineLedgerFor(expiresAt, new Date(), sequence);
    try {
      const txHash = await this.invoke('create', [
        new Address(this.keypair.publicKey()).toScVal(),
        nativeToScVal(code, { type: 'symbol' }),
        nativeToScVal(usdcToStroops(amountUSDC), { type: 'i128' }),
        nativeToScVal(deadlineLedger, { type: 'u32' }),
      ]);
      return { txHash, amountUSDC, deadlineLedger };
    } catch (err) {
      if (
        !(err instanceof InvoiceContractError) ||
        err.contractCode !== INVOICE_ERROR.AlreadyExists
      ) {
        throw err;
      }
      const existing = await this.getInvoice(code);
      return {
        txHash: null,
        amountUSDC: stroopsToUsdc(existing.amount),
        deadlineLedger: existing.deadline,
      };
    }
  }

  async cancelInvoice(code: string): Promise<string> {
    return this.invoke('cancel', [nativeToScVal(code, { type: 'symbol' })]);
  }

  /** Read-only `get` via simulation — no fee, nothing submitted. */
  async getInvoice(
    code: string,
  ): Promise<{ amount: bigint; deadline: number; status: number }> {
    const { sim } = await this.simulate('get', [
      nativeToScVal(code, { type: 'symbol' }),
    ]);
    return scValToNative(sim.result!.retval) as {
      amount: bigint;
      deadline: number;
      status: number;
    };
  }

  /** Also called by POST /pay/:code/submitted so a contract payment is seen without waiting a tick. */
  @Interval(POLL_INTERVAL_MS)
  async pollEvents(): Promise<void> {
    if (!this.enabled || this.polling) return;
    this.polling = true;
    try {
      await this.drainEvents();
    } catch (err) {
      this.logger.error(
        'Invoice event poll failed',
        err instanceof Error ? err.stack : String(err),
      );
    } finally {
      this.polling = false;
    }
  }

  private async drainEvents(): Promise<void> {
    // Keyed by contract id: a redeploy starts a fresh cursor instead of reusing the old one.
    const cursorId = `soroban-invoice:${this.contractId}`;
    const filters: rpc.Api.EventFilter[] = [
      {
        type: 'contract',
        contractIds: [this.contractId!],
        topics: [
          [nativeToScVal('paid', { type: 'symbol' }).toXDR('base64'), '*'],
        ],
      },
    ];

    const saved = await this.prisma.listenerCursor.findUnique({
      where: { id: cursorId },
    });
    let request: rpc.Api.GetEventsRequest = saved
      ? { filters, cursor: saved.pagingToken, limit: EVENTS_PAGE_LIMIT }
      : {
          filters,
          startLedger: (await this.server.getLatestLedger()).sequence,
          limit: EVENTS_PAGE_LIMIT,
        };

    for (;;) {
      let page: rpc.Api.GetEventsResponse;
      try {
        page = await this.server.getEvents(request);
      } catch (err) {
        if (!request.cursor) throw err;
        // The saved cursor fell out of RPC retention (backend was down too long): replay from the
        // oldest ledger RPC still has — ProcessedOperation makes the replay idempotent.
        const { oldestLedger } = await this.server.getHealth();
        this.logger.warn(
          `Invoice event cursor rejected (${err instanceof Error ? err.message : String(err)}); ` +
            `resuming from ledger ${oldestLedger}`,
        );
        request = {
          filters,
          startLedger: oldestLedger,
          limit: EVENTS_PAGE_LIMIT,
        };
        continue;
      }

      for (const event of page.events) {
        await this.handleEvent(event);
      }
      await this.prisma.listenerCursor.upsert({
        where: { id: cursorId },
        create: { id: cursorId, pagingToken: page.cursor },
        update: { pagingToken: page.cursor },
      });
      if (page.events.length < EVENTS_PAGE_LIMIT) return;
      request = { filters, cursor: page.cursor, limit: EVENTS_PAGE_LIMIT };
    }
  }

  private async handleEvent(event: rpc.Api.EventResponse): Promise<void> {
    const paid = event.inSuccessfulContractCall
      ? parsePaidEvent(event.topic, event.value)
      : null;
    if (!paid) return;

    const opId = `soroban:${event.id}`;
    if (await this.paymentsService.markProcessed(opId)) return;

    this.logger.log(
      `Invoice paid event: ${paid.code}, ${paid.amountUSDC.toFixed(7)} USDC from ${paid.payer}, tx ${event.txHash}`,
    );
    const op: InboundOp = {
      opId,
      txHash: event.txHash,
      from: paid.payer,
      to: paid.merchant,
      assetType: 'credit_alphanum4',
      assetCode: this.assetCode,
      assetIssuer: this.assetIssuer,
      amount: paid.amountUSDC.toFixed(7),
      memoType: 'none',
      successful: true,
    };
    const link = await this.prisma.paymentLink.findUnique({
      where: { code: paid.code },
    });

    let result: MatchResult;
    if (paid.merchant !== this.keypair.publicKey()) {
      // Only the admin creates invoices and always pays out to itself — the USDC went elsewhere.
      result = {
        kind: 'ignored',
        reason: 'contract rail: invoice payout is not the platform account',
      };
    } else if (!link) {
      result = {
        kind: 'ignored',
        reason: 'contract rail: no matching link for invoice code',
      };
    } else {
      result = matchAmount(link, paid.amountUSDC);
    }
    await this.paymentsService.recordMatch(
      result.kind === 'ignored' ? null : link,
      op,
      paid.code,
      result,
      event.ledger,
      'contract',
    );
  }

  private async simulate(method: string, args: xdr.ScVal[]) {
    if (!this.enabled) {
      throw new InvoiceContractError(null, 'INVOICE_CONTRACT_ID is not set');
    }
    const account = await this.server.getAccount(this.keypair.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(new Contract(this.contractId!).call(method, ...args))
      .setTimeout(60)
      .build();
    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new InvoiceContractError(
        contractErrorCode(sim.error),
        `invoice.${method} simulation failed: ${sim.error}`,
      );
    }
    return { tx, sim };
  }

  /** Simulates, signs as the platform (admin) account, submits and waits; returns the tx hash. */
  private async invoke(method: string, args: xdr.ScVal[]): Promise<string> {
    const { tx, sim } = await this.simulate(method, args);
    const prepared = rpc.assembleTransaction(tx, sim).build();
    prepared.sign(this.keypair);

    const sent = await this.server.sendTransaction(prepared);
    if (sent.status !== 'PENDING' && sent.status !== 'DUPLICATE') {
      throw new InvoiceContractError(
        null,
        `invoice.${method} submit returned ${sent.status} (tx ${sent.hash})`,
      );
    }
    const result = await this.server.pollTransaction(sent.hash, {
      attempts: 30,
    });
    if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new InvoiceContractError(
        null,
        `invoice.${method} tx ${sent.hash} ended ${result.status}`,
      );
    }
    this.logger.log(`invoice.${method} submitted, tx hash: ${sent.hash}`);
    return sent.hash;
  }
}
