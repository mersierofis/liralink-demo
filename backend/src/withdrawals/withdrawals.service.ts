import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  ANCHOR_ADAPTER,
  type AnchorAdapter,
  settlementModeFor,
} from '../anchor/anchor.adapter';
import { BalanceService } from '../balance/balance.service';
import { Decimal } from '../common/decimal';
import { Paginated } from '../common/dto/pagination.dto';
import { Withdrawal } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateWithdrawalDto } from './dto/create-withdrawal.dto';

// A requested/processing withdrawal older than this was interrupted (process restart) — re-run it.
const STUCK_AFTER_MS = 5 * 60_000;

@Injectable()
export class WithdrawalsService {
  private readonly logger = new Logger(WithdrawalsService.name);
  private reconciling = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly balanceService: BalanceService,
    @Inject(ANCHOR_ADAPTER) private readonly anchor: AnchorAdapter,
  ) {}

  /** Reserves the amount immediately (non-failed withdrawals count against availableTRY), then
   * pays out through the anchor in the background. Balance mode only. */
  async create(
    merchantId: string,
    dto: CreateWithdrawalDto,
  ): Promise<Withdrawal> {
    if (settlementModeFor(this.anchor.name) === 'auto_payout') {
      // The anchor pays the IBAN during settlement (docs/anchor.md) — nothing accrues to withdraw.
      throw new ConflictException('Payouts are automatic in this mode');
    }
    const amountTRY = new Decimal(dto.amountTRY);
    if (amountTRY.lessThanOrEqualTo(0)) {
      throw new BadRequestException('amountTRY must be greater than 0.00');
    }

    const withdrawal = await this.prisma.$transaction(async (tx) => {
      // Serialize withdrawals per merchant so two concurrent requests can't spend the same balance.
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${merchantId}))`;

      const merchant = await tx.merchant.findUniqueOrThrow({
        where: { id: merchantId },
      });
      const iban = dto.iban ?? merchant.iban;
      if (!iban) {
        throw new BadRequestException(
          'iban is required: pass it in the body or set it with PATCH /me',
        );
      }
      const { availableTRY } = await this.balanceService.getBalance(
        merchantId,
        tx,
      );
      if (amountTRY.greaterThan(availableTRY)) {
        throw new UnprocessableEntityException(
          `amountTRY ${amountTRY.toFixed(2)} exceeds availableTRY ${availableTRY}`,
        );
      }
      return tx.withdrawal.create({
        data: { merchantId, amountTRY, iban, status: 'requested' },
      });
    });

    this.logger.log(
      `Withdrawal ${withdrawal.id} requested: ${amountTRY.toFixed(2)} TRY → ${withdrawal.iban}`,
    );
    void this.payout(withdrawal);
    return withdrawal;
  }

  private async payout(withdrawal: Withdrawal): Promise<void> {
    try {
      await this.prisma.withdrawal.update({
        where: { id: withdrawal.id },
        data: { status: 'processing' },
      });
      const { ref } = await this.anchor.payoutTRY({
        withdrawalId: withdrawal.id,
        amountTRY: withdrawal.amountTRY,
        iban: withdrawal.iban,
      });
      await this.prisma.withdrawal.update({
        where: { id: withdrawal.id },
        data: { status: 'completed', anchorRef: ref, completedAt: new Date() },
      });
      this.logger.log(`Withdrawal ${withdrawal.id} completed (${ref})`);
    } catch (err) {
      // A failed withdrawal no longer counts against availableTRY — the reservation is released.
      await this.prisma.withdrawal
        .update({ where: { id: withdrawal.id }, data: { status: 'failed' } })
        .catch(() => undefined);
      this.logger.error(
        `Withdrawal ${withdrawal.id} failed`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async reconcile(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const stuck = await this.prisma.withdrawal.findMany({
        where: {
          status: { in: ['requested', 'processing'] },
          createdAt: { lt: new Date(Date.now() - STUCK_AFTER_MS) },
        },
      });
      for (const w of stuck) {
        this.logger.warn(`Re-running interrupted withdrawal ${w.id}`);
        await this.payout(w);
      }
    } catch (err) {
      this.logger.error(
        'Withdrawal reconcile failed',
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
  ): Promise<Paginated<Withdrawal>> {
    const where = { merchantId };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.withdrawal.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.withdrawal.count({ where }),
    ]);
    return { items, total };
  }
}
