import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Decimal } from '../common/decimal';
import { Payment } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InboundOp } from '../stellar/matcher';

export const PAYMENT_DETECTED_EVENT = 'payment.detected';

export interface PaymentDetectedEvent {
  payment: Payment;
  linkId: string;
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
}
