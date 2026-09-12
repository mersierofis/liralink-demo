/**
 * seed.ts — idempotent demo data for LiraLink.
 *
 * Usage:
 *   npm run seed            (also runs on `npx prisma migrate reset`)
 *
 * Demo login: demo@liralink.app ("Erdemli Narenciye A.Ş."). The password comes from
 * SEED_DEMO_PASSWORD in backend/.env — never committed, never printed (ask Hasan). Re-running with
 * a new value rotates it.
 *
 * Which merchant becomes the demo account, in order:
 *   1. the merchant already registered as demo@liralink.app (upsert by email);
 *   2. otherwise the merchant owning the real testnet-paid links in REAL_LINK_CODES —
 *      it is renamed in place so the demo shows real tx hashes;
 *   3. otherwise (fresh DB) a new merchant plus 3 open links.
 *
 * Never creates or modifies links that already exist, and never writes Payment or
 * Settlement rows: a paid link must come from a real testnet transaction.
 */
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as bcrypt from 'bcryptjs';
import { PrismaPg } from '@prisma/adapter-pg';
import { Merchant, Prisma, PrismaClient } from '../src/generated/prisma/client';
import { Decimal } from '../src/common/decimal';
import { generateLinkCode } from '../src/links/code-generator';

// Load the backend .env regardless of the process cwd (already-set env vars win).
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const DEMO = {
  email: 'demo@liralink.app',
  businessName: 'Erdemli Narenciye A.Ş.',
  iban: 'TR330006100519786457841326',
};

// Same cost and minimum length as AuthService / RegisterDto.
const BCRYPT_COST = 10;
const MIN_PASSWORD_LENGTH = 8;

// Links paid with real testnet USDC on 2026-09-12 (memo rail).
const REAL_LINK_CODES = ['VHHCJ8QZ', 'WNWCMGXA', 'WPQRQDT4'];

// Fresh-DB links stay open long enough to survive until demo day.
const FRESH_LINK_EXPIRY_HOURS = 24 * 30;
const MAX_CODE_RETRIES = 5;

const FRESH_LINKS = [
  {
    title: 'Erdemli limon — 20 kg koli',
    description: 'Enterdonat limon, birinci sınıf, Erdemli çıkışlı',
    amountTRY: '1850.00',
  },
  {
    title: 'Satsuma mandalina — 500 kg palet',
    description: 'Soğuk zincir, Mersin Limanı teslim',
    amountTRY: '9750.00',
  },
  {
    title: 'Washington portakal — 1 ton, FOB Mersin',
    description: 'Ihracat kalitesi, fitosanitar sertifikalı',
    amountTRY: '42500.00',
  },
];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (backend/.env)`);
  return value;
}

async function findDemoMerchant(
  prisma: PrismaClient,
): Promise<{ merchant: Merchant; via: string } | null> {
  const byEmail = await prisma.merchant.findUnique({
    where: { email: DEMO.email },
  });
  if (byEmail) return { merchant: byEmail, via: 'existing demo email' };

  const realLinks = await prisma.paymentLink.findMany({
    where: { code: { in: REAL_LINK_CODES } },
    select: { merchantId: true },
  });
  const ownerIds = [...new Set(realLinks.map((l) => l.merchantId))];
  if (ownerIds.length > 1) {
    throw new Error(
      `Links ${REAL_LINK_CODES.join(', ')} belong to ${ownerIds.length} different merchants — refusing to guess the demo account`,
    );
  }
  if (ownerIds.length === 1) {
    const owner = await prisma.merchant.findUniqueOrThrow({
      where: { id: ownerIds[0] },
    });
    return { merchant: owner, via: 'owner of real testnet links' };
  }
  return null;
}

async function createLink(
  tx: Prisma.TransactionClient,
  merchantId: string,
  link: (typeof FRESH_LINKS)[number],
  rate: Decimal,
) {
  const amountTRY = new Decimal(link.amountTRY);
  // Same rounding as FxService.quote: round UP so the payer never underpays.
  const quotedUSDC = amountTRY
    .dividedBy(rate)
    .toDecimalPlaces(7, Decimal.ROUND_UP);
  const now = Date.now();
  const quoteTtlMinutes = Number(requireEnv('QUOTE_TTL_MINUTES'));

  for (let attempt = 0; ; attempt++) {
    try {
      return await tx.paymentLink.create({
        data: {
          code: generateLinkCode(),
          merchantId,
          title: link.title,
          description: link.description,
          amountTRY,
          quotedUSDC,
          fxRate: rate,
          quoteExpiresAt: new Date(now + quoteTtlMinutes * 60_000),
          expiresAt: new Date(now + FRESH_LINK_EXPIRY_HOURS * 3_600_000),
        },
      });
    } catch (err) {
      const uniqueViolation =
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002';
      if (!uniqueViolation || attempt >= MAX_CODE_RETRIES) throw err;
    }
  }
}

async function main() {
  const demoPassword = requireEnv('SEED_DEMO_PASSWORD');
  if (demoPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `SEED_DEMO_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  }
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: requireEnv('DATABASE_URL') }),
  });

  try {
    const found = await findDemoMerchant(prisma);
    let merchantId: string;

    if (found) {
      const { merchant, via } = found;
      const passwordMatches = await bcrypt.compare(
        demoPassword,
        merchant.passwordHash,
      );
      await prisma.merchant.update({
        where: { id: merchant.id },
        data: {
          email: DEMO.email,
          businessName: DEMO.businessName,
          iban: DEMO.iban,
          ...(passwordMatches
            ? {}
            : { passwordHash: await bcrypt.hash(demoPassword, BCRYPT_COST) }),
        },
      });
      merchantId = merchant.id;
      console.log(
        `Updated merchant ${merchant.id} (${via}; was ${merchant.email}; password ${passwordMatches ? 'unchanged' : 'set from SEED_DEMO_PASSWORD'})`,
      );
    } else {
      const rate = new Decimal(requireEnv('FX_MOCK_RATE_TRY_PER_USDC'));
      const passwordHash = await bcrypt.hash(demoPassword, BCRYPT_COST);
      merchantId = await prisma.$transaction(async (tx) => {
        const merchant = await tx.merchant.create({
          data: {
            email: DEMO.email,
            passwordHash,
            businessName: DEMO.businessName,
            iban: DEMO.iban,
          },
        });
        for (const link of FRESH_LINKS) {
          await createLink(tx, merchant.id, link, rate);
        }
        return merchant.id;
      });
      console.log(
        `Created merchant ${merchantId} with ${FRESH_LINKS.length} open links`,
      );
    }

    const summary = await prisma.merchant.findUniqueOrThrow({
      where: { id: merchantId },
      include: { links: { include: { payments: true } } },
    });
    console.log(
      `Demo login: ${DEMO.email} (password: SEED_DEMO_PASSWORD in backend/.env) — ${summary.businessName}, unallocatedUSDC ${summary.unallocatedUSDC.toFixed(7)}`,
    );
    for (const link of summary.links) {
      const hashes = link.payments.map((p) => p.txHash).join(', ') || '—';
      console.log(
        `  ${link.code}  ${link.status.padEnd(9)} ${link.amountTRY.toFixed(2)} TRY  tx: ${hashes}`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
