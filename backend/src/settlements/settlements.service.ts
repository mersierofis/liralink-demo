import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  ANCHOR_ADAPTER,
  ANCHOR_ADAPTERS,
  type AnchorAdapter,
} from '../anchor/anchor.adapter';
import { Paginated } from '../common/dto/pagination.dto';
import { Merchant, Settlement } from '../generated/prisma/client';
import {
  PAYMENT_DETECTED_EVENT,
  type PaymentDetectedEvent,
} from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  InvalidFeeError,
  netSettlementTRY,
  splitSettlement,
} from './settlement-math';

// A pending/processing mock settlement older than this was interrupted (process restart) — re-run it.
const STUCK_AFTER_MS = 5 * 60_000;

@Injectable()
export class SettlementsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SettlementsService.name);
  private reconciling = false;
  // Settlements with an adapter call in flight in this process — never run one twice at once
  // (the SEP-24 adapter must not build two payments for the same settlement).
  private readonly running = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ANCHOR_ADAPTER) private readonly anchor: AnchorAdapter,
    @Inject(ANCHOR_ADAPTERS)
    private readonly adapters: Record<string, AnchorAdapter>,
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
    await this.run(settlement, link.merchant);
  }

  /** Starts or resumes a settlement on the provider it was created with. */
  private async run(settlement: Settlement, merchant: Merchant): Promise<void> {
    const { id } = settlement;
    if (this.running.has(id)) return;
    const adapter = this.adapters[settlement.provider];
    if (!adapter) {
      this.logger.error(
        `Settlement ${id}: provider "${settlement.provider}" is not available`,
      );
      return;
    }
    this.running.add(id);
    try {
      if (settlement.status === 'pending' && !settlement.blockedReason) {
        await this.prisma.settlement.update({
          where: { id },
          data: { status: 'processing' },
        });
      }
      const result = await adapter.settleToTRY({
        settlement,
        merchant,
        save: async (patch) => {
          await this.prisma.settlement.update({ where: { id }, data: patch });
        },
      });
      switch (result.status) {
        case 'completed': {
          let netTRY: ReturnType<typeof netSettlementTRY>;
          try {
            // An adapter that knows what the anchor actually paid out (SEP-6 `amount_out`) wins
            // over deriving it from the fee — that figure is the money that reached the IBAN.
            netTRY =
              result.netTRY ??
              netSettlementTRY(
                settlement.amountTRY,
                settlement.amountUSDC,
                result.feeUSDC,
              );
          } catch (err) {
            if (!(err instanceof InvalidFeeError)) throw err;
            // Terminal, not transient: the anchor's reported fee won't change on a retry.
            await this.prisma.settlement.update({
              where: { id },
              data: {
                status: 'failed',
                anchorRef: result.ref,
                failReason: 'invalid_fee',
                feeUSDC: result.feeUSDC,
              },
            });
            this.logger.error(
              `Settlement ${id} failed (invalid_fee): ${err.message} — not retried`,
            );
            break;
          }
          await this.prisma.settlement.update({
            where: { id },
            data: {
              status: 'completed',
              anchorRef: result.ref,
              blockedReason: null,
              feeUSDC: result.feeUSDC,
              netTRY,
              completedAt: new Date(),
            },
          });
          this.logger.log(
            `Settlement ${id} completed (${result.ref}): ${netTRY.toFixed(2)} TRY net of a ${result.feeUSDC.toFixed(7)} USDC fee`,
          );
          break;
        }
        case 'processing':
          await this.prisma.settlement.update({
            where: { id },
            data: {
              status: 'processing',
              anchorRef: result.ref,
              blockedReason: null,
            },
          });
          break;
        case 'blocked':
          await this.prisma.settlement.update({
            where: { id },
            data: { status: 'pending', blockedReason: result.reason },
          });
          if (settlement.blockedReason !== result.reason) {
            this.logger.warn(
              `Settlement ${id} blocked (${result.reason}): ${result.detail} — retried every minute`,
            );
          }
          break;
        case 'failed':
          // Terminal: failed settlements are never picked up by reconcile again.
          await this.prisma.settlement.update({
            where: { id },
            data: {
              status: 'failed',
              anchorRef: result.ref,
              failReason: result.reason,
            },
          });
          this.logger.error(
            `Settlement ${id} failed (${result.reason}): ${result.detail} — not retried`,
          );
          break;
      }
    } catch (err) {
      // Transient (network, Horizon, anchor 5xx): the settlement stays where it is and the minute
      // job resumes it. Adapters persist progress before irreversible steps, so retrying is safe.
      this.logger.error(
        `Settlement ${id} attempt failed, will retry`,
        err instanceof Error ? err.stack : String(err),
      );
    } finally {
      this.running.delete(id);
    }
  }

  /**
   * Safety net for missed `payment.detected` events (a restart between detection and
   * settlement, or links paid before settlements existed): settles every paid link that has
   * no settlement yet, via its completing (latest) payment. Then resumes unfinished settlements:
   * interrupted mock runs, and every SEP-24 one (waiting on KYC or the anchor, or blocked).
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

      const unfinished = await this.prisma.settlement.findMany({
        where: {
          status: { in: ['pending', 'processing'] },
          OR: [
            { provider: { not: 'mock' } },
            { createdAt: { lt: new Date(Date.now() - STUCK_AFTER_MS) } },
          ],
        },
        include: { merchant: true },
        orderBy: { createdAt: 'asc' },
      });
      for (const s of unfinished) {
        if (s.provider === 'mock') {
          this.logger.warn(`Re-running interrupted settlement ${s.id}`);
        }
        await this.run(s, s.merchant);
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
