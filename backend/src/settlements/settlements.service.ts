import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ANCHOR_ADAPTER, type AnchorAdapter } from '../anchor/anchor.adapter';
import { Decimal } from '../common/decimal';
import { Paginated } from '../common/dto/pagination.dto';
import { Merchant, Settlement } from '../generated/prisma/client';
import {
  PAYMENT_DETECTED_EVENT,
  type PaymentDetectedEvent,
} from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { splitSettlement } from './settlement-math';

// A pending/processing settlement older than this was interrupted (process restart) — re-run it.
const STUCK_AFTER_MS = 5 * 60_000;

@Injectable()
export class SettlementsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SettlementsService.name);
  private reconciling = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ANCHOR_ADAPTER) private readonly anchor: AnchorAdapter,
  ) {}

  onApplicationBootstrap(): void {
    void this.reconcile();
  }

  @OnEvent(PAYMENT_DETECTED_EVENT, { async: true })
  async onPaymentDetected(event: PaymentDetectedEvent): Promise<void> {
    try {
      await this.settlePayment(event.payment.id);
    } catch (err) {
      this.logger.error(
        `Settlement for payment ${event.payment.id} failed`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * Creates and runs the settlement for the payment that completed a link. Idempotent: the
   * unique `paymentId` means a second call (event + reconcile racing) is a no-op.
   */
  async settlePayment(paymentId: string): Promise<void> {
    const payment = await this.prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: { link: { include: { merchant: true } } },
    });
    const { link } = payment;
    if (link.status !== 'paid') return;

    const amounts = splitSettlement(
      link.amountTRY,
      link.quotedUSDC,
      link.merchant.autoSavePercent,
    );
    let settlement: Settlement;
    try {
      settlement = await this.prisma.settlement.create({
        data: {
          merchantId: link.merchantId,
          paymentId,
          amountUSDC: amounts.amountUSDC,
          amountTRY: amounts.amountTRY,
          fxRate: link.fxRate,
          savedUSDC: amounts.savedUSDC,
          provider: this.anchor.name,
          status: 'pending',
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) return;
      throw err;
    }
    this.logger.log(
      `Settlement ${settlement.id} created for link ${link.code}: ${amounts.amountTRY.toFixed(2)} TRY ` +
        `(${amounts.amountUSDC.toFixed(7)} USDC to anchor, ${amounts.savedUSDC.toFixed(7)} USDC saved)`,
    );
    await this.run(settlement.id, amounts.amountUSDC, link.merchant);
  }

  private async run(
    settlementId: string,
    amountUSDC: Decimal,
    merchant: Merchant,
  ): Promise<void> {
    await this.prisma.settlement.update({
      where: { id: settlementId },
      data: { status: 'processing' },
    });
    try {
      const { ref } = await this.anchor.settleToTRY({
        settlementId,
        amountUSDC,
        merchant,
      });
      await this.prisma.settlement.update({
        where: { id: settlementId },
        data: { status: 'completed', anchorRef: ref, completedAt: new Date() },
      });
      this.logger.log(`Settlement ${settlementId} completed (${ref})`);
    } catch (err) {
      await this.prisma.settlement.update({
        where: { id: settlementId },
        data: { status: 'failed' },
      });
      this.logger.error(
        `Settlement ${settlementId} failed`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * Safety net for missed `payment.detected` events (a restart between detection and
   * settlement, or links paid before settlements existed): settles every paid link that has
   * no settlement yet, via its completing (latest) payment, and re-runs interrupted ones.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async reconcile(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const unsettled = await this.prisma.paymentLink.findMany({
        where: {
          status: 'paid',
          payments: { some: {}, none: { settlement: { isNot: null } } },
        },
        include: { payments: { orderBy: { detectedAt: 'desc' }, take: 1 } },
      });
      for (const link of unsettled) {
        this.logger.warn(`Settling link ${link.code} missed by the event path`);
        await this.settlePayment(link.payments[0].id);
      }

      const stuck = await this.prisma.settlement.findMany({
        where: {
          status: { in: ['pending', 'processing'] },
          createdAt: { lt: new Date(Date.now() - STUCK_AFTER_MS) },
        },
        include: { merchant: true },
      });
      for (const s of stuck) {
        this.logger.warn(`Re-running interrupted settlement ${s.id}`);
        await this.run(s.id, s.amountUSDC, s.merchant);
      }
    } catch (err) {
      this.logger.error(
        'Settlement reconcile failed',
        err instanceof Error ? err.stack : String(err),
      );
    } finally {
      this.reconciling = false;
    }
  }

  async findAll(
    merchantId: string,
    page: number,
    limit: number,
  ): Promise<Paginated<Settlement>> {
    const where = { merchantId };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.settlement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.settlement.count({ where }),
    ]);
    return { items, total };
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === 'P2002'
  );
}
