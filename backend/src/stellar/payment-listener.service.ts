import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Horizon } from '@stellar/stellar-sdk';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { ListenerStatusService } from './listener-status.service';
import {
  decodeMemoCode,
  InboundOp,
  LinkForMatch,
  match,
  MatchConfig,
} from './matcher';
import { StellarService } from './stellar.service';

const LISTENER_CURSOR_ID = 'horizon-payments';
const MAX_BACKOFF_MS = 30_000;
const STREAM_RECONNECT_TIMEOUT_MS = 30_000;
const RECONCILE_PAGE_LIMIT = 200;

type PaymentLikeRecord =
  | Horizon.ServerApi.PaymentOperationRecord
  | Horizon.ServerApi.PathPaymentOperationRecord
  | Horizon.ServerApi.PathPaymentStrictSendOperationRecord;

const PAYMENT_LIKE_TYPES = new Set([
  'payment',
  'path_payment_strict_receive',
  'path_payment_strict_send',
]);

function isPaymentLikeOperation(
  record: Horizon.ServerApi.OperationRecord,
): record is PaymentLikeRecord {
  return PAYMENT_LIKE_TYPES.has(record.type);
}

@Injectable()
export class PaymentListenerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentListenerService.name);
  private readonly matchConfig: MatchConfig;

  private cursor = 'now';
  private closeStream: (() => void) | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private destroyed = false;

  constructor(
    private readonly stellarService: StellarService,
    private readonly prisma: PrismaService,
    private readonly paymentsService: PaymentsService,
    private readonly listenerStatus: ListenerStatusService,
    config: ConfigService,
  ) {
    this.matchConfig = {
      platformAddress: this.stellarService.platformPublicKey,
      assetCode: config.get<string>('USDC_CODE')!,
      assetIssuer: config.get<string>('USDC_ISSUER')!,
    };
  }

  async onModuleInit(): Promise<void> {
    const cursorRow = await this.prisma.listenerCursor.findUnique({
      where: { id: LISTENER_CURSOR_ID },
    });
    this.cursor = cursorRow?.pagingToken ?? 'now';
    this.connect();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.closeStream?.();
  }

  private connect(): void {
    this.logger.log(
      `Connecting Horizon payments stream from cursor "${this.cursor}"`,
    );
    this.listenerStatus.set('running');

    this.closeStream = this.stellarService.server
      .payments()
      .forAccount(this.matchConfig.platformAddress)
      .join('transactions')
      .cursor(this.cursor)
      .stream({
        reconnectTimeout: STREAM_RECONNECT_TIMEOUT_MS,
        onmessage: (record) => {
          this.reconnectAttempt = 0;
          if (!isPaymentLikeOperation(record)) return;
          this.handleRecord(record).catch((err: unknown) => {
            this.logger.error(
              'Failed to handle payment record',
              err instanceof Error ? err.stack : String(err),
            );
          });
        },
        onerror: (err: unknown) => {
          this.logger.error(
            `Horizon payments stream error: ${err instanceof Error ? err.message : String(err)}`,
          );
          this.listenerStatus.set('stopped');
          this.scheduleReconnect();
        },
      });
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) return;
    const delayMs = Math.min(1000 * 2 ** this.reconnectAttempt, MAX_BACKOFF_MS);
    this.reconnectAttempt++;
    this.logger.warn(`Reconnecting Horizon payments stream in ${delayMs}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.closeStream?.();
      this.connect();
    }, delayMs);
  }

  /** Fetches every operation of a specific transaction and runs it through the same matcher —
   * used by POST /pay/:code/submitted as an immediate check that doesn't wait on the stream. */
  async checkTransactionHash(txHash: string): Promise<void> {
    const page = await this.stellarService.server
      .operations()
      .forTransaction(txHash)
      .join('transactions')
      .call();
    for (const record of page.records) {
      if (isPaymentLikeOperation(record)) {
        await this.handleRecord(record);
      }
    }
  }

  @Cron('*/2 * * * *')
  async reconcile(): Promise<void> {
    try {
      const cursorRow = await this.prisma.listenerCursor.findUnique({
        where: { id: LISTENER_CURSOR_ID },
      });
      if (!cursorRow) return; // nothing has ever been processed yet — no gap to close

      const page = await this.stellarService.server
        .payments()
        .forAccount(this.matchConfig.platformAddress)
        .join('transactions')
        .cursor(cursorRow.pagingToken)
        .order('asc')
        .limit(RECONCILE_PAGE_LIMIT)
        .call();

      for (const record of page.records) {
        if (isPaymentLikeOperation(record)) {
          await this.handleRecord(record);
        }
      }
    } catch (err) {
      this.logger.error(
        'Reconciliation poll failed',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  private async handleRecord(record: PaymentLikeRecord): Promise<void> {
    // Our own outgoing transactions (future withdrawals) show up here too — not a payer attempt.
    if (record.to !== this.matchConfig.platformAddress) {
      await this.advanceCursor(record.paging_token);
      return;
    }

    const alreadyProcessed = await this.markProcessed(record.id);
    if (alreadyProcessed) {
      await this.advanceCursor(record.paging_token);
      return;
    }

    const tx = await record.transaction();
    const op: InboundOp = {
      opId: record.id,
      txHash: record.transaction_hash,
      from: record.from,
      to: record.to,
      assetType: record.asset_type,
      assetCode: record.asset_code,
      assetIssuer: record.asset_issuer,
      amount: record.amount,
      memoType: tx.memo_type,
      memoBytes: tx.memo_bytes,
      successful: tx.successful,
    };

    const linkCode =
      op.memoType === 'text' && op.memoBytes
        ? decodeMemoCode(op.memoBytes)
        : null;
    const linkEntity = linkCode
      ? await this.prisma.paymentLink.findUnique({ where: { code: linkCode } })
      : null;
    const linkForMatch: LinkForMatch | null = linkEntity
      ? {
          code: linkEntity.code,
          status: linkEntity.status,
          quotedUSDC: linkEntity.quotedUSDC,
        }
      : null;

    const result = match(op, linkForMatch, this.matchConfig);

    if (result.kind === 'paid') {
      await this.paymentsService.recordPayment(
        linkEntity!.id,
        op,
        result.amountUSDC,
        tx.ledger_attr,
      );
    } else {
      await this.paymentsService.recordAttempt(
        op,
        linkCode,
        result.kind === 'underpaid' ? 'underpaid' : result.reason,
      );
    }

    await this.advanceCursor(record.paging_token);
  }

  /** Returns true if this operation was already processed (idempotency check via unique constraint). */
  private async markProcessed(opId: string): Promise<boolean> {
    try {
      await this.prisma.processedOperation.create({ data: { opId } });
      return false;
    } catch (err) {
      if (this.isUniqueViolation(err)) return true;
      throw err;
    }
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      err.code === 'P2002'
    );
  }

  private async advanceCursor(pagingToken: string): Promise<void> {
    await this.prisma.listenerCursor.upsert({
      where: { id: LISTENER_CURSOR_ID },
      create: { id: LISTENER_CURSOR_ID, pagingToken },
      update: { pagingToken },
    });
  }
}
