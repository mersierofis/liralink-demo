import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Decimal } from '../common/decimal';
import { Payment } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InboundOp } from '../stellar/matcher';

export const PAYMENT_DETECTED_EVENT = 'payment.detected';
export const PAYMENT_STRAY_EVENT = 'payment.stray';

export interface PaymentDetectedEvent {
  payment: Payment;
  linkId: string;
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

  async recordPayment(
    linkId: string,
    merchantId: string,
    op: InboundOp,
    amountUSDC: Decimal,
    totalReceivedUSDC: Decimal,
    excessUSDC: Decimal,
    ledger: number,
  ): Promise<Payment> {
    const payment = await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          linkId,
          txHash: op.txHash,
          payerAddress: op.from,
          amountUSDC,
          rail: 'memo',
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
      `Payment detected: link ${linkId}, tx ${op.txHash}, ${amountUSDC.toFixed(7)} USDC` +
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

  /** Partial payment: link stays open for a top-up, nothing settles yet. */
  async recordUnderpayment(
    linkId: string,
    totalReceivedUSDC: Decimal,
    shortfallUSDC: Decimal,
  ): Promise<void> {
    await this.prisma.paymentLink.update({
      where: { id: linkId },
      data: {
        status: 'underpaid',
        receivedUSDC: totalReceivedUSDC,
        shortfallUSDC,
      },
    });
    this.logger.warn(
      `Link ${linkId} underpaid: received ${totalReceivedUSDC.toFixed(7)} USDC, ` +
        `shortfall ${shortfallUSDC.toFixed(7)} USDC`,
    );
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
