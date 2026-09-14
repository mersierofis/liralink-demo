import {
  BadRequestException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { StrKey } from '@stellar/stellar-sdk';
import { BalanceService } from '../balance/balance.service';
import { Decimal } from '../common/decimal';
import { Paginated } from '../common/dto/pagination.dto';
import type { UsdcWithdrawal } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from '../stellar/stellar.service';
import { CreateUsdcWithdrawalDto } from './dto/create-usdc-withdrawal.dto';

/** Why a USDC withdrawal is 'failed' — terminal; the debit is released. */
export type UsdcWdFailReason = 'failed_on_ledger' | 'expired_unsubmitted';

// The signed payment is valid this long; one that never landed by then is failed and released.
export const USDC_WD_TX_TIMEOUT_SECONDS = 120;
// A submitted row younger than this may still be in create()'s own submit — the job leaves it.
const RECONCILE_AFTER_MS = 30_000;

@Injectable()
export class UsdcWithdrawalsService {
  private readonly logger = new Logger(UsdcWithdrawalsService.name);
  private reconciling = false;
  // The platform account has one sequence number: sign, persist and submit one payment at a time.
  // In-process only — the API runs as a single instance (systemd liralink-api).
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly balanceService: BalanceService,
    private readonly stellar: StellarService,
  ) {}

  /**
   * Debits savedUSDC or unallocatedUSDC and sends the USDC from the platform account. The signed
   * transaction (hash + XDR) is committed together with the debit BEFORE it is submitted, so every
   * retry — here or in the minute job — resubmits that same transaction: it lands at most once.
   */
  async create(
    merchantId: string,
    dto: CreateUsdcWithdrawalDto,
  ): Promise<UsdcWithdrawal> {
    const amountUSDC = new Decimal(dto.amountUSDC);
    if (amountUSDC.lessThanOrEqualTo(0)) {
      throw new BadRequestException(
        'amountUSDC must be greater than 0.0000000',
      );
    }
    if (!StrKey.isValidEd25519PublicKey(dto.destination)) {
      throw new BadRequestException(
        'destination must be a Stellar account address (G…)',
      );
    }
    if (dto.destination === this.stellar.platformPublicKey) {
      throw new UnprocessableEntityException(
        'destination is the LiraLink platform account — use your own wallet address',
      );
    }
    const problem = await this.stellar.usdcDestinationProblem(
      dto.destination,
      amountUSDC,
    );
    if (problem) throw new UnprocessableEntityException(problem);

    return this.serialized(async () => {
      const withdrawal = await this.prisma.$transaction(
        async (tx) => {
          // Same per-merchant lock as POST /withdrawals: two requests can't spend the same balance.
          await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${merchantId}))`;

          const balance = await this.balanceService.getBalance(merchantId, tx);
          const available = new Decimal(
            dto.source === 'saved'
              ? balance.savedUSDC
              : balance.unallocatedUSDC,
          );
          if (amountUSDC.greaterThan(available)) {
            throw new UnprocessableEntityException(
              `amountUSDC ${amountUSDC.toFixed(7)} exceeds ${dto.source}USDC ${available.toFixed(7)}`,
            );
          }
          if (dto.source === 'unallocated') {
            await tx.merchant.update({
              where: { id: merchantId },
              data: { unallocatedUSDC: { decrement: amountUSDC } },
            });
          }
          const signed = await this.stellar.buildUsdcPayment(
            dto.destination,
            amountUSDC.toFixed(7),
            USDC_WD_TX_TIMEOUT_SECONDS,
          );
          return tx.usdcWithdrawal.create({
            data: {
              merchantId,
              amountUSDC,
              destination: dto.destination,
              source: dto.source,
              txHash: signed.hash().toString('hex'),
              txXdr: signed.toXDR(),
            },
          });
        },
        { timeout: 20_000 },
      );
      this.logger.log(
        `USDC withdrawal ${withdrawal.id} signed: ${amountUSDC.toFixed(7)} USDC (${dto.source}) → ${dto.destination}, tx ${withdrawal.txHash}`,
      );
      return this.resolve(withdrawal);
    });
  }

  /**
   * Moves a submitted row forward from what the ledger says: landed → completed; failed on the
   * ledger, or expired without ever landing → failed and the debit released; otherwise
   * (re)submits the same signed transaction. A submit error leaves it submitted for the job.
   */
  async resolve(withdrawal: UsdcWithdrawal): Promise<UsdcWithdrawal> {
    const onLedger = await this.stellar.findTransaction(withdrawal.txHash);
    if (onLedger) {
      return onLedger.successful
        ? this.complete(withdrawal)
        : this.fail(withdrawal, 'failed_on_ledger');
    }
    const tx = this.stellar.transactionFromXdr(withdrawal.txXdr);
    if (await this.stellar.expired(tx)) {
      return this.fail(withdrawal, 'expired_unsubmitted');
    }
    try {
      await this.stellar.submitSigned(tx);
    } catch (err) {
      // tx_failed is still recorded on the ledger (fee charged) — terminal. Anything else
      // (timeout, bad sequence, Horizon down) stays submitted until it lands or expires.
      if (await this.stellar.findTransaction(withdrawal.txHash)) {
        return this.fail(withdrawal, 'failed_on_ledger');
      }
      this.logger.warn(
        `USDC withdrawal ${withdrawal.id}: submit of tx ${withdrawal.txHash} failed, will retry — ${err instanceof Error ? err.message : String(err)}`,
      );
      return withdrawal;
    }
    return this.complete(withdrawal);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async reconcile(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const open = await this.prisma.usdcWithdrawal.findMany({
        where: {
          status: 'submitted',
          createdAt: { lt: new Date(Date.now() - RECONCILE_AFTER_MS) },
        },
        orderBy: { createdAt: 'asc' },
      });
      for (const w of open) {
        await this.serialized(() => this.resolve(w));
      }
    } catch (err) {
      this.logger.error(
        'USDC withdrawal reconcile failed',
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
  ): Promise<Paginated<UsdcWithdrawal>> {
    const where = { merchantId };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.usdcWithdrawal.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.usdcWithdrawal.count({ where }),
    ]);
    return { items, total };
  }

  private async complete(withdrawal: UsdcWithdrawal): Promise<UsdcWithdrawal> {
    await this.prisma.usdcWithdrawal.updateMany({
      where: { id: withdrawal.id, status: 'submitted' },
      data: { status: 'completed', completedAt: new Date() },
    });
    this.logger.log(
      `USDC withdrawal ${withdrawal.id} completed, tx ${withdrawal.txHash}`,
    );
    return this.prisma.usdcWithdrawal.findUniqueOrThrow({
      where: { id: withdrawal.id },
    });
  }

  /** Terminal. Releases the debit exactly once: only the call that flips submitted → failed does. */
  private async fail(
    withdrawal: UsdcWithdrawal,
    failReason: UsdcWdFailReason,
  ): Promise<UsdcWithdrawal> {
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.usdcWithdrawal.updateMany({
        where: { id: withdrawal.id, status: 'submitted' },
        data: { status: 'failed', failReason },
      });
      if (count === 1 && withdrawal.source === 'unallocated') {
        await tx.merchant.update({
          where: { id: withdrawal.merchantId },
          data: { unallocatedUSDC: { increment: withdrawal.amountUSDC } },
        });
      }
    });
    this.logger.error(
      `USDC withdrawal ${withdrawal.id} failed (${failReason}), tx ${withdrawal.txHash} — ${withdrawal.amountUSDC.toFixed(7)} USDC released to ${withdrawal.source}USDC`,
    );
    return this.prisma.usdcWithdrawal.findUniqueOrThrow({
      where: { id: withdrawal.id },
    });
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
