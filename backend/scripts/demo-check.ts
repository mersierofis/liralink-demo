/**
 * demo-check.ts — one screen to read before every demo rehearsal. Read-only: sends nothing, writes nothing.
 *
 * Usage:
 *   npm run demo:check
 *   npm run demo:check -- --api https://liralink-api.tutorialplatform.com/api --payer G...
 *
 * --api defaults to http://localhost:3000/api. The payer is --payer, else DEMO_PAYER_ADDRESS, else
 * `stellar keys address payer`. Horizon, USDC and DATABASE_URL come from backend/.env; links and
 * payments are the demo merchant's (demo@liralink.app).
 *
 * Prints: /health, platform + payer USDC balances, open links, anchor mode, last 3 payments with
 * rails. Exits 1 with a NOT READY line if the API is down/unhealthy, the listener is stopped, or a
 * balance can't pay a demo link.
 */
import { execFileSync } from 'child_process';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { Horizon, Keypair } from '@stellar/stellar-sdk';
import { Decimal } from '../src/common/decimal';
import { PrismaClient } from '../src/generated/prisma/client';

dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const DEMO_EMAIL = 'demo@liralink.app';
// The payer needs enough for a demo link; below this the check fails.
const MIN_PAYER_USDC = new Decimal(5);
const MIN_PLATFORM_USDC = new Decimal(1);

interface Health {
  ok: boolean;
  horizon: string;
  anchor: string;
  listener: string;
  platformAccount: string;
  settlementMode: string;
}

function parseArgs(argv: string[]): { api: string; payer?: string } {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) {
      throw new Error(`Unexpected argument: ${argv[i]}`);
    }
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return {
    api: (out.api ?? 'http://localhost:3000/api').replace(/\/$/, ''),
    payer: out.payer ?? process.env.DEMO_PAYER_ADDRESS,
  };
}

async function fetchHealth(api: string): Promise<Health | string> {
  try {
    const res = await fetch(`${api}/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return `HTTP ${res.status}`;
    return (await res.json()) as Health;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function payerFromCli(): string | undefined {
  try {
    return execFileSync('stellar', ['keys', 'address', 'payer'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

/** USDC balance string, or why there is none. */
async function usdcBalance(
  server: Horizon.Server,
  address: string,
): Promise<Decimal | string> {
  try {
    const account = await server.loadAccount(address);
    const line = account.balances.find(
      (b) =>
        'asset_code' in b &&
        b.asset_code === process.env.USDC_CODE &&
        b.asset_issuer === process.env.USDC_ISSUER,
    );
    return line ? new Decimal(line.balance) : 'no USDC trustline';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function ago(date: Date): string {
  const min = Math.round((Date.now() - date.getTime()) / 60_000);
  if (min < 60) return `${min}m ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)}h ago`;
  return `${Math.round(min / 1440)}d ago`;
}

const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;

async function main(): Promise<void> {
  const { api, payer: payerArg } = parseArgs(process.argv.slice(2));
  const problems: string[] = [];
  const row = (label: string, value: string) =>
    console.log(`  ${label.padEnd(18)}${value}`);

  const server = new Horizon.Server(
    process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org',
  );
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString)
    throw new Error('DATABASE_URL is not set (backend/.env)');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });

  try {
    const health = await fetchHealth(api);
    const platform =
      typeof health === 'string'
        ? process.env.PLATFORM_ACCOUNT_SECRET &&
          Keypair.fromSecret(process.env.PLATFORM_ACCOUNT_SECRET).publicKey()
        : health.platformAccount;
    const payer = payerArg ?? payerFromCli();

    const [platformUSDC, payerUSDC, merchant] = await Promise.all([
      platform ? usdcBalance(server, platform) : 'unknown',
      payer ? usdcBalance(server, payer) : 'skipped',
      prisma.merchant.findUnique({ where: { email: DEMO_EMAIL } }),
    ]);

    console.log(`LiraLink demo check — ${new Date().toISOString()}`);
    console.log(`  api ${api}\n`);

    if (typeof health === 'string') {
      row('health', `DOWN (${health})`);
      problems.push(`API /health unreachable: ${health}`);
    } else {
      row(
        'health',
        `${health.ok ? 'ok' : 'NOT OK'} · horizon ${health.horizon} · listener ${health.listener}`,
      );
      row('anchor', `${health.anchor} (${health.settlementMode})`);
      if (!health.ok)
        problems.push(`/health ok=false (horizon ${health.horizon})`);
      if (health.listener !== 'running')
        problems.push(`payment listener is ${health.listener}`);
    }

    const balanceRow = (
      label: string,
      address: string | undefined,
      value: Decimal | string,
      min: Decimal,
    ) => {
      const who = address ? ` (${short(address)})` : '';
      if (typeof value === 'string') {
        row(label, `${value}${who}`);
        if (value !== 'skipped') problems.push(`${label}: ${value}`);
        return;
      }
      row(label, `${value.toFixed(7)} USDC${who}`);
      if (value.lessThan(min))
        problems.push(`${label} ${value.toFixed(7)} < ${min.toFixed(0)} USDC`);
    };
    balanceRow(
      'platform USDC',
      platform || undefined,
      platformUSDC,
      MIN_PLATFORM_USDC,
    );
    balanceRow('payer USDC', payer, payerUSDC, MIN_PAYER_USDC);
    if (!payer) row('', 'pass --payer G… or set DEMO_PAYER_ADDRESS');

    if (!merchant) {
      row('demo merchant', `${DEMO_EMAIL} not found — run \`npm run seed\``);
      problems.push(`no merchant ${DEMO_EMAIL}`);
      return;
    }

    const now = new Date();
    const [open, underpaid, payments] = await Promise.all([
      prisma.paymentLink.count({
        where: {
          merchantId: merchant.id,
          status: 'open',
          expiresAt: { gt: now },
        },
      }),
      prisma.paymentLink.count({
        where: { merchantId: merchant.id, status: 'underpaid' },
      }),
      prisma.payment.findMany({
        where: { link: { merchantId: merchant.id } },
        orderBy: { detectedAt: 'desc' },
        take: 3,
        include: { link: { select: { code: true, status: true } } },
      }),
    ]);
    row('open links', `${open} open · ${underpaid} underpaid  (${DEMO_EMAIL})`);

    console.log('\n  last 3 payments');
    if (payments.length === 0) console.log('    none');
    for (const p of payments) {
      console.log(
        `    ${p.rail.padEnd(9)}${p.link.code}  ${p.amountUSDC.toFixed(7).padStart(12)} USDC  ` +
          `${ago(p.detectedAt).padEnd(8)} ${p.link.status.padEnd(10)}tx ${short(p.txHash)}`,
      );
    }
  } finally {
    await prisma.$disconnect();
    console.log(
      problems.length === 0
        ? '\nREADY'
        : `\nNOT READY\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
    if (problems.length > 0) process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
