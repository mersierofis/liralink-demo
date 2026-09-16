// Must stay the first import — see the helper.
import { restoreEnv, SEP6_E2E } from './helpers/sep6.env';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { App } from 'supertest/types';
import { AnchorHttpError, AnchorSession } from '../src/anchor/anchor-session';
import { anchorMemoFor } from '../src/anchor/sep6';
import type { TransferTransaction } from '../src/anchor/transfer';
import { AppModule } from '../src/app.module';
import { Decimal } from '../src/common/decimal';
import { Settlement } from '../src/generated/prisma/client';
import { PaymentsService } from '../src/payments/payments.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { InboundOp } from '../src/stellar/matcher';

const IBAN = 'TR330006100519786457841326';

// Live: SEP-10 + SEP-6 withdraw on tr-mock-anchor.fly.dev and a real ~1 USDC testnet payment.
// Run with `SEP6_E2E=1 npm run test:e2e -- sep6`.
(SEP6_E2E ? describe : describe.skip)('SEP-6 settlement (e2e, live)', () => {
  jest.setTimeout(300_000);

  let app: INestApplication<App>;
  let prisma: PrismaService;
  let payments: PaymentsService;
  let session: AnchorSession;
  const email = `e2e-sep6-${Date.now()}@liralink.app`;
  let token: string;
  let merchantId: string;

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);

  /** Creates a link and records a full payment the way the listener does (emits payment.detected). */
  async function payLink(amountTRY: string) {
    const res = await auth(http().post('/api/links'))
      .send({ title: `sep6 ${amountTRY}`, amountTRY })
      .expect(201);
    const link = await prisma.paymentLink.findUniqueOrThrow({
      where: { id: res.body.id as string },
    });
    const op: InboundOp = {
      opId: `e2e-${randomBytes(8).toString('hex')}`,
      txHash: randomBytes(32).toString('hex'),
      from: 'GBRZSG7K6ZXJRCMYM2O2HO2DKR7RO2ACZ5FARBMQZBB4YZMDFDXFUTV7',
      to: 'GDWV6USF4R2ULWR5XW3TEUZSIRGRCU7PQWGSBDYJVIRFNAJ3LVNQ34N2',
      assetType: 'credit_alphanum4',
      assetCode: 'USDC',
      amount: link.quotedUSDC.toFixed(7),
      memoType: 'text',
      successful: true,
    };
    const payment = await payments.recordPayment(
      link.id,
      link.merchantId,
      op,
      link.quotedUSDC,
      link.quotedUSDC,
      new Decimal(0),
      1,
    );
    return { link, payment };
  }

  async function settlementWhen(
    paymentId: string,
    predicate: (s: Settlement) => boolean,
    timeoutMs: number,
  ): Promise<Settlement> {
    const until = Date.now() + timeoutMs;
    let last: Settlement | null = null;
    while (Date.now() < until) {
      last = await prisma.settlement.findUnique({ where: { paymentId } });
      if (last && predicate(last)) return last;
      await sleep(2_000);
    }
    throw new Error(
      `settlement never reached the expected state; last: ${JSON.stringify(last)}`,
    );
  }

  /** Fail a settlement rather than delete it, so the minute job neither resumes it nor re-settles. */
  async function park(id: string) {
    await prisma.settlement.update({
      where: { id },
      data: { status: 'failed' },
    });
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    prisma = moduleFixture.get(PrismaService);
    payments = moduleFixture.get(PaymentsService);
    session = moduleFixture.get(AnchorSession);
    await app.init();

    const res = await http()
      .post('/api/auth/register')
      .send({ email, password: 'demo1234', businessName: 'e2e sep6' })
      .expect(201);
    token = res.body.token as string;
    merchantId = res.body.merchant.id as string;
  });

  afterAll(async () => {
    if (merchantId) {
      await prisma.withdrawal.deleteMany({ where: { merchantId } });
      await prisma.settlement.deleteMany({ where: { merchantId } });
      await prisma.payment.deleteMany({ where: { link: { merchantId } } });
      await prisma.paymentLink.deleteMany({ where: { merchantId } });
      await prisma.merchant.delete({ where: { id: merchantId } });
    }
    await app.close();
    restoreEnv();
  });

  it('prices links off the anchor SEP-38 quote', async () => {
    const res = await http().get('/api/fx').expect(200);
    expect(res.body).toMatchObject({ pair: 'USDC/TRY', source: 'anchor' });
    // The anchor floats around 48 TRY/USDC; the mock rate is 34.00, so this is visibly not it.
    expect(new Decimal(res.body.rate as string).greaterThan(40)).toBe(true);
  });

  it('reports settlementMode auto_payout', async () => {
    const res = await auth(http().get('/api/me')).expect(200);
    expect(res.body).toMatchObject({ settlementMode: 'auto_payout' });
  });

  it('blocks without an IBAN — nothing opened at the anchor', async () => {
    const { payment } = await payLink('50.00');
    const s = await settlementWhen(
      payment.id,
      (x) => x.blockedReason !== null,
      30_000,
    );
    expect(s).toMatchObject({
      provider: 'sep6',
      status: 'pending',
      blockedReason: 'missing_iban',
      anchorRef: null,
      anchorTxHash: null,
    });
    await park(s.id);
  });

  it('blocks below the anchor minimum of 1 USDC — nothing sent', async () => {
    await auth(http().patch('/api/me')).send({ iban: IBAN }).expect(200);
    // ~35 TRY is around 0.72 USDC: inside the advertised /info minimum of 0.5, but the anchor
    // itself enforces 1 USDC and only says so when the withdraw is opened.
    const { payment } = await payLink('35.00');
    const s = await settlementWhen(
      payment.id,
      (x) => x.blockedReason !== null,
      60_000,
    );
    expect(s).toMatchObject({
      status: 'pending',
      blockedReason: 'outside_anchor_limits',
      anchorTxHash: null,
    });
    await park(s.id);
  });

  it('settles end-to-end: withdraw → USDC payment with an id memo → anchor completed', async () => {
    const { payment } = await payLink('50.00'); // ~1.03 USDC at the anchor rate
    const s = await settlementWhen(
      payment.id,
      (x) => x.status === 'completed' || x.status === 'failed',
      280_000,
    );
    expect(s.status).toBe('completed');
    expect(s.provider).toBe('sep6');
    expect(s.anchorRef).toMatch(/^sep_/);
    expect(s.anchorTxHash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.completedAt).not.toBeNull();
    // SEP-6 is programmatic — there is never an interactive page to send the merchant to.
    expect(s.interactiveUrl).toBeNull();

    // The USDC really left the platform account for the anchor, with the anchor's id memo.
    const tx = (await (
      await fetch(`${process.env.HORIZON_URL}/transactions/${s.anchorTxHash}`)
    ).json()) as { successful: boolean; memo_type: string };
    expect(tx.successful).toBe(true);
    expect(tx.memo_type).toBe('id');

    // netTRY is the lira the anchor reports paying out, and it is what lands in paidOutTRY
    // (auto_payout — the merchant never withdraws it by hand).
    const netTRY = new Decimal(s.netTRY!.toString());
    expect(netTRY.greaterThan(0)).toBe(true);
    const balance = await auth(http().get('/api/balance')).expect(200);
    expect(balance.body).toMatchObject({
      availableTRY: '0.00',
      pendingTRY: '0.00',
      paidOutTRY: netTRY.toFixed(2),
    });

    const list = await auth(http().get('/api/settlements')).expect(200);
    const item = (list.body.items as Record<string, unknown>[]).find(
      (i) => i.id === s.id,
    );
    expect(item).toMatchObject({
      provider: 'sep6',
      status: 'completed',
      anchorRef: s.anchorRef,
      netTRY: netTRY.toFixed(2),
      interactiveUrl: null,
    });
    expect(item).not.toHaveProperty('anchorStatus');
    expect(item).not.toHaveProperty('anchorTxXdr');
    expect(item).not.toHaveProperty('anchorMemo');

    // Issue #21: the withdrawal belongs to this merchant's own anchor user (sub G…:memo) …
    const memo = anchorMemoFor(merchantId);
    expect(s.anchorMemo).toBe(memo);
    const transferServer = await session.transferServer('sep6');
    const txnUrl = `${transferServer}/transaction?${new URLSearchParams({ id: s.anchorRef! })}`;
    const { transaction } = await session.request<{
      transaction: TransferTransaction;
    }>(txnUrl, { token: await session.token(memo) });
    // … so the bare platform account — every other merchant's view — cannot even see it.
    const asOmnibus = await session
      .request(txnUrl, { token: await session.token() })
      .then(
        () => 200,
        (err: unknown) => (err instanceof AnchorHttpError ? err.status : -1),
      );
    expect(asOmnibus).toBe(404);

    // The TRY went to the IBAN registered over SEP-12, not the sandbox's default account.
    const merchant = await prisma.merchant.findUniqueOrThrow({
      where: { id: merchantId },
    });
    expect(merchant).toMatchObject({
      sep12Iban: IBAN,
      sep12HomeDomain: 'tr-mock-anchor.fly.dev',
    });
    expect(merchant.sep12CustomerId).toMatch(/^cus_/);
    expect(transaction.to).toBe(IBAN);
    expect(transaction.external_transaction_id).toEqual(expect.any(String));
    console.log(
      `sep6 e2e: withdrawal ${s.anchorRef} as ${memo} → ${transaction.to} ` +
        `(bank ref ${transaction.external_transaction_id}), ${netTRY.toFixed(2)} TRY, tx ${s.anchorTxHash}`,
    );
  });
});
