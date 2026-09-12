import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Decimal } from '../common/decimal';
import { Payment, PaymentLink, PayRail } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InboundOp, MatchResult } from '../stellar/matcher';

export const PAYMENT_DETECTED_EVENT = 'payment.detected';
export const PAYMENT_STRAY_EVENT = 'payment.stray';

export interface PaymentDetectedEvent {
  payment: Payment;
  linkId: string;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === 'P2002'
  );
}

export interface PaymentStrayEvent {
  linkId: string;
  merchantId: string;
  txHash: string;
  amountUSDC: string;
  reason: string;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  /** Returns true if this operation/event was already processed (idempotency via unique constraint). */
  async markProcessed(opId: string): Promise<boolean> {
    try {
      await this.prisma.processedOperation.create({ data: { opId } });
      return false;
    } catch (err) {
      if (isUniqueViolation(err)) return true;
      throw err;
    }
  }

  /** Routes a matcher result to the matching record* call — shared by the memo and contract rails. */
  async recordMatch(
    link: PaymentLink | null,
    op: InboundOp,
    linkCode: string | null,
    result: MatchResult,
    ledger: number,
    rail: PayRail,
  ): Promise<void> {
    if (result.kind === 'paid') {
      await this.recordPayment(
        link!.id,
        link!.merchantId,
        op,
        result.amountUSDC,
        result.totalReceivedUSDC,
        result.excessUSDC,
        ledger,
        rail,
      );
    } else if (result.kind === 'underpaid') {
      await this.recordUnderpayment(
        link!.id,
        op,
        result.amountUSDC,
        result.totalReceivedUSDC,
        result.shortfallUSDC,
        ledger,
        rail,
      );
    } else if (result.kind === 'stray') {
      await this.recordStray(
        link!.id,
        link!.merchantId,
        op,
        linkCode,
        result.amountUSDC,
        result.reason,
      );
    } else {
      await this.recordAttempt(op, linkCode, result.reason);
    }
  }

  async recordPayment(
    linkId: string,
    merchantId: string,
    op: InboundOp,
    amountUSDC: Decimal,
    totalReceivedUSDC: Decimal,
    excessUSDC: Decimal,
    ledger: number,
    rail: PayRail = 'memo',
  ): Promise<Payment> {
    const payment = await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          linkId,
          txHash: op.txHash,
          payerAddress: op.from,
          amountUSDC,
          rail,
          ledger,
        },
      });
      await tx.paymentLink.update({
        where: { id: linkId },
        data: {
          status: 'paid',
          receivedUSDC: totalReceivedUSDC,
          shortfallUSDC: null,
        },
      });
      if (excessUSDC.greaterThan(0)) {
        await tx.merchant.update({
          where: { id: merchantId },
          data: { unallocatedUSDC: { increment: excessUSDC } },
        });
      }
      return payment;
    });

    this.logger.log(
      `Payment detected (${rail}): link ${linkId}, tx ${op.txHash}, ${amountUSDC.toFixed(7)} USDC` +
        (excessUSDC.greaterThan(0)
          ? ` (${excessUSDC.toFixed(7)} USDC overpaid → merchant.unallocatedUSDC)`
          : ''),
    );
    this.events.emit(PAYMENT_DETECTED_EVENT, {
      payment,
      linkId,
    } satisfies PaymentDetectedEvent);
    return payment;
  }

  /**
   * Partial payment: this transfer is recorded as its own Payment row (every
   * successful transfer gets one), the link stays `underpaid` for a later top-up,
   * and nothing settles yet (no `payment.detected` — settlement only fires on paid).
   */
  async recordUnderpayment(
    linkId: string,
    op: InboundOp,
    amountUSDC: Decimal,
    totalReceivedUSDC: Decimal,
    shortfallUSDC: Decimal,
    ledger: number,
    rail: PayRail = 'memo',
  ): Promise<Payment> {
    const payment = await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          linkId,
          txHash: op.txHash,
          payerAddress: op.from,
          amountUSDC,
          rail,
          ledger,
        },
      });
      await tx.paymentLink.update({
        where: { id: linkId },
        data: {
          status: 'underpaid',
          receivedUSDC: totalReceivedUSDC,
          shortfallUSDC,
        },
      });
      return payment;
    });
    this.logger.warn(
      `Link ${linkId} underpaid: transfer ${amountUSDC.toFixed(7)} USDC ` +
        `(tx ${op.txHash}), received ${totalReceivedUSDC.toFixed(7)} USDC, ` +
        `shortfall ${shortfallUSDC.toFixed(7)} USDC`,
    );
    return payment;
  }

  async recordAttempt(
    op: InboundOp,
    linkCode: string | null,
    reason: string,
  ): Promise<void> {
    await this.prisma.paymentAttempt.create({
      data: {
        opId: op.opId,
        linkCode: linkCode ?? undefined,
        txHash: op.txHash,
        fromAddr: op.from,
        amountUSDC: new Decimal(op.amount),
        assetCode: op.assetCode ?? 'unknown',
        reason,
      },
    });
    this.logger.warn(
      `Payment attempt not credited: tx ${op.txHash}, reason: ${reason}`,
    );
  }

  /**
   * Stray payment: a valid USDC payment whose memo matches a real link that is no
   * longer payable (paid/expired/cancelled). The money reached the platform, so we
   * both record the attempt (audit) AND credit it to the link's merchant as
   * unallocatedUSDC — never auto-converted to TRY. Emits `payment.stray`.
   */
  async recordStray(
    linkId: string,
    merchantId: string,
    op: InboundOp,
    linkCode: string | null,
    amountUSDC: Decimal,
    reason: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.paymentAttempt.create({
        data: {
          opId: op.opId,
          linkCode: linkCode ?? undefined,
          txHash: op.txHash,
          fromAddr: op.from,
          amountUSDC,
          assetCode: op.assetCode ?? 'unknown',
          reason: `stray: ${reason}`,
        },
      });
      await tx.merchant.update({
        where: { id: merchantId },
        data: { unallocatedUSDC: { increment: amountUSDC } },
      });
    });
    this.logger.warn(
      `Stray payment: tx ${op.txHash}, ${amountUSDC.toFixed(7)} USDC ` +
        `credited to merchant.unallocatedUSDC (${reason})`,
    );
    this.events.emit(PAYMENT_STRAY_EVENT, {
      linkId,
      merchantId,
      txHash: op.txHash,
      amountUSDC: amountUSDC.toFixed(7),
      reason,
    } satisfies PaymentStrayEvent);
  }
}
