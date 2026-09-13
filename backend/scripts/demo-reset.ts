/**
 * demo-reset.ts — put the demo merchant's TRY ledger back into a clean state before a demo.
 *
 * Usage:
 *   npm run demo:reset               apply
 *   npm run demo:reset -- --dry-run  print what would change, write nothing
 *
 * For demo@liralink.app only, in one transaction:
 *   - deletes mock withdrawals (anchorRef `mock-payout-…`, or never paid out) — panel test runs;
 *   - re-runs mock settlements the way MockAnchorAdapter completes them (no fee, netTRY = amountTRY,
 *     `mock-settle-…` ref): unfinished/failed mock settlements are completed, and a paid link with no
 *     settlement gets one for its completing (latest) payment;
 *   - checks availableTRY (BalanceService) == Σ netTRY of completed balance-mode settlements.
 *
 * Never touches the merchant, links, payments, unallocatedUSDC, or non-mock rows (sep24 settlements,
 * withdrawals with a real anchor ref) — those are reported and, if they break the invariant, the
 * run fails. Idempotent: a second run changes nothing.
 */
import * as path from 'path';
import * as dotenv from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { BALANCE_MODE_PROVIDERS } from '../src/anchor/anchor.adapter';
import { BalanceService } from '../src/balance/balance.service';
import { Decimal } from '../src/common/decimal';
import { Prisma, PrismaClient } from '../src/generated/prisma/client';
import type { PrismaService } from '../src/prisma/prisma.service';
import { splitSettlement } from '../src/settlements/settlement-math';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const DEMO_EMAIL = 'demo@liralink.app';
const MOCK_PROVIDER = 'mock';

export interface DemoResetReport {
  deletedWithdrawals: { id: string; amountTRY: string; status: string }[];
  completedSettlements: {
    id: string;
    linkCode: string;
    previousStatus: string;
  }[];
  createdSettlements: { id: string; linkCode: string }[];
  skipped: string[];
  availableTRY: string;
  completedNetTRY: string;
}

class DryRunRollback extends Error {
  constructor(readonly report: DemoResetReport) {
    super('dry run');
  }
}

export async function resetDemoMerchant(
  prisma: PrismaClient,
  merchantId: string,
  opts: { dryRun?: boolean } = {},
): Promise<DemoResetReport> {
  try {
    return await prisma.$transaction(async (tx) => {
      const report = await reset(tx, merchantId);
      if (opts.dryRun) throw new DryRunRollback(report);
      return report;
    });
  } catch (err) {
    if (err instanceof DryRunRollback) return err.report;
    throw err;
  }
}

async function reset(
  tx: Prisma.TransactionClient,
  merchantId: string,
): Promise<DemoResetReport> {
  const merchant = await tx.merchant.findUniqueOrThrow({
    where: { id: merchantId },
  });
  const report: DemoResetReport = {
    deletedWithdrawals: [],
    completedSettlements: [],
    createdSettlements: [],
    skipped: [],
    availableTRY: '',
    completedNetTRY: '',
  };

  // 1. Mock withdrawals. A real anchor always leaves its own ref, so null = never paid out.
  const withdrawals = await tx.withdrawal.findMany({ where: { merchantId } });
  for (const w of withdrawals) {
    if (w.anchorRef === null || w.anchorRef.startsWith('mock-payout-')) {
      await tx.withdrawal.delete({ where: { id: w.id } });
      report.deletedWithdrawals.push({
        id: w.id,
        amountTRY: w.amountTRY.toFixed(2),
        status: w.status,
      });
    } else {
      report.skipped.push(`withdrawal ${w.id} (anchorRef ${w.anchorRef})`);
    }
  }

  // 2a. Unfinished or failed settlements — complete the mock ones as MockAnchorAdapter would.
  const unfinished = await tx.settlement.findMany({
    where: { merchantId, status: { not: 'completed' } },
    include: { payment: { include: { link: true } } },
  });
  for (const s of unfinished) {
    if (s.provider !== MOCK_PROVIDER) {
      report.skipped.push(`settlement ${s.id} (${s.provider}, ${s.status})`);
      continue;
    }
    await tx.settlement.update({
      where: { id: s.id },
      data: mockCompletion(s.id, s.amountTRY),
    });
    report.completedSettlements.push({
      id: s.id,
      linkCode: s.payment.link.code,
      previousStatus: s.status,
    });
  }

  // 2b. Paid links with no settlement (same selection as SettlementsService.reconcile).
  const unsettled = await tx.paymentLink.findMany({
    where: {
      merchantId,
      status: 'paid',
      payments: { some: {}, none: { settlement: { isNot: null } } },
    },
    include: { payments: { orderBy: { detectedAt: 'desc' }, take: 1 } },
  });
  for (const link of unsettled) {
    const amounts = splitSettlement(
      link.amountTRY,
      link.quotedUSDC,
      merchant.autoSavePercent,
    );
    const created = await tx.settlement.create({
      data: {
        merchantId,
        paymentId: link.payments[0].id,
        amountUSDC: amounts.amountUSDC,
        amountTRY: amounts.amountTRY,
        fxRate: link.fxRate,
        savedUSDC: amounts.savedUSDC,
        provider: MOCK_PROVIDER,
        status: 'pending',
      },
    });
    await tx.settlement.update({
      where: { id: created.id },
      data: mockCompletion(created.id, amounts.amountTRY),
    });
    report.createdSettlements.push({ id: created.id, linkCode: link.code });
  }

  // 3. The invariant, read through the same code the API serves /balance with.
  const balance = await new BalanceService(
    tx as unknown as PrismaService,
  ).getBalance(merchantId, tx);
  const completed = await tx.settlement.findMany({
    where: {
      merchantId,
      status: 'completed',
      provider: { in: BALANCE_MODE_PROVIDERS },
    },
  });
  const completedNetTRY = completed.reduce(
    (sum, s) => sum.plus(s.netTRY ?? s.amountTRY),
    new Decimal(0),
  );
  report.availableTRY = balance.availableTRY;
  report.completedNetTRY = completedNetTRY.toFixed(2);
  if (report.availableTRY !== report.completedNetTRY) {
    throw new Error(
      `availableTRY ${report.availableTRY} != Σ completed netTRY ${report.completedNetTRY} — ` +
        `left untouched: ${report.skipped.join('; ') || 'nothing'}`,
    );
  }
  return report;
}

function mockCompletion(
  settlementId: string,
  amountTRY: Decimal,
): Prisma.SettlementUpdateInput {
  return {
    status: 'completed',
    anchorRef: `mock-settle-${settlementId}`,
    feeUSDC: new Decimal(0),
    netTRY: amountTRY,
    blockedReason: null,
    failReason: null,
    completedAt: new Date(),
  };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString)
    throw new Error('DATABASE_URL is not set (backend/.env)');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
  try {
    const merchant = await prisma.merchant.findUnique({
      where: { email: DEMO_EMAIL },
    });
    if (!merchant) {
      throw new Error(`No merchant ${DEMO_EMAIL} — run \`npm run seed\` first`);
    }
    const r = await resetDemoMerchant(prisma, merchant.id, { dryRun });
    const say = (done: string, todo: string) =>
      dryRun ? `would ${todo}` : done;
    console.log(`${dryRun ? '[dry run] ' : ''}${DEMO_EMAIL} (${merchant.id})`);
    for (const w of r.deletedWithdrawals) {
      console.log(
        `  ${say('deleted', 'delete')} withdrawal ${w.id}  ${w.amountTRY} TRY (${w.status})`,
      );
    }
    for (const s of r.completedSettlements) {
      console.log(
        `  ${say('completed', 'complete')} settlement ${s.id}  ${s.linkCode} (was ${s.previousStatus})`,
      );
    }
    for (const s of r.createdSettlements) {
      console.log(
        `  ${say('created', 'create')} settlement ${s.id}  ${s.linkCode}`,
      );
    }
    for (const s of r.skipped) console.log(`  left untouched: ${s}`);
    const changes =
      r.deletedWithdrawals.length +
      r.completedSettlements.length +
      r.createdSettlements.length;
    if (changes === 0) console.log('  already clean — nothing to change');
    console.log(
      `  availableTRY ${r.availableTRY} = Σ completed netTRY ${r.completedNetTRY}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
