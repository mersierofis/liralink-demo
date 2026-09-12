// Must stay the first import — see the helper.
import { restoreEnv, SEP24_E2E } from './helpers/sep24.env';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { Decimal } from '../src/common/decimal';
import { Settlement } from '../src/generated/prisma/client';
import { PaymentsService } from '../src/payments/payments.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { InboundOp } from '../src/stellar/matcher';

const IBAN = 'TR330006100519786457841326';

// Live: SEP-10 + SEP-24 withdraw on testanchor.stellar.org and a real 1 USDC testnet payment.
// Run with `SEP24_E2E=1 npm run test:e2e -- sep24`.
(SEP24_E2E ? describe : describe.skip)('SEP-24 settlement (e2e, live)', () => {
  jest.setTimeout(300_000);

  let app: INestApplication<App>;
  let prisma: PrismaService;
  let payments: PaymentsService;
  const email = `e2e-sep24-${Date.now()}@liralink.app`;
  let token: string;
  let merchantId: string;

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);

  /** Creates a link and records a full payment the way the listener does (emits payment.detected). */
  async function payLink(amountTRY: string) {
    const res = await auth(http().post('/api/links'))
      .send({ title: `sep24 ${amountTRY}`, amountTRY })
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
    await app.init();

    const res = await http()
      .post('/api/auth/register')
      .send({ email, password: 'demo1234', businessName: 'e2e sep24' })
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

  it('blocks without an IBAN — nothing opened at the anchor', async () => {
    const { payment } = await payLink('34.00');
    const s = await settlementWhen(
      payment.id,
      (x) => x.blockedReason !== null,
      30_000,
    );
    expect(s).toMatchObject({
      provider: 'sep24',
      status: 'pending',
      blockedReason: 'missing_iban',
      anchorRef: null,
      anchorTxHash: null,
    });
    await prisma.settlement.delete({ where: { id: s.id } });
  });

  it('blocks above the anchor maximum (10 USDC) — nothing opened at the anchor', async () => {
    await auth(http().patch('/api/me')).send({ iban: IBAN }).expect(200);
    const { payment } = await payLink('408.00'); // 12 USDC at 34.00
    const s = await settlementWhen(
      payment.id,
      (x) => x.blockedReason !== null,
      30_000,
    );
    expect(s).toMatchObject({
      status: 'pending',
      blockedReason: 'outside_anchor_limits',
      anchorRef: null,
      anchorTxHash: null,
    });
    await prisma.settlement.delete({ where: { id: s.id } });
  });

  it('settles 1 USDC end-to-end: withdraw → KYC → payment with memo → anchor completed', async () => {
    const { payment } = await payLink('34.00'); // 1 USDC at 34.00
    const s = await settlementWhen(
      payment.id,
      (x) => x.status === 'completed' || x.status === 'failed',
      280_000,
    );
    expect(s.status).toBe('completed');
    expect(s.provider).toBe('sep24');
    expect(s.anchorRef).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.anchorTxHash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.completedAt).not.toBeNull();

    // The USDC really left the platform account for the anchor, with the anchor's memo.
    const tx = (await (
      await fetch(`${process.env.HORIZON_URL}/transactions/${s.anchorTxHash}`)
    ).json()) as { successful: boolean; memo_type: string };
    expect(tx.successful).toBe(true);
    expect(tx.memo_type).not.toBe('none');

    const balance = await auth(http().get('/api/balance')).expect(200);
    expect(balance.body.availableTRY).toBe('34.00');

    // API shape unchanged: SEP-24 internals are not exposed.
    const list = await auth(http().get('/api/settlements')).expect(200);
    const item = (list.body.items as Record<string, unknown>[]).find(
      (i) => i.id === s.id,
    );
    expect(item).toMatchObject({
      provider: 'sep24',
      status: 'completed',
      anchorRef: s.anchorRef,
    });
    expect(item).not.toHaveProperty('interactiveUrl');
    expect(item).not.toHaveProperty('anchorTxXdr');
  });
});
