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
    op: InboundOp,
    amountUSDC: Decimal,
    ledger: number,
  ): Promise<Payment> {
    const payment = await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          linkId,
          txHash: op.txHash,
          payerAddress: op.from,
          amountUSDC,
          ledger,
        },
      });
      await tx.paymentLink.update({
        where: { id: linkId },
        data: { status: 'paid' },
      });
      return payment;
    });

    this.logger.log(
      `Payment detected: link ${linkId}, tx ${op.txHash}, ${amountUSDC.toFixed(7)} USDC`,
    );
    this.events.emit(PAYMENT_DETECTED_EVENT, {
      payment,
      linkId,
    } satisfies PaymentDetectedEvent);
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
}
