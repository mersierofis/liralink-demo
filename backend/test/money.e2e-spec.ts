// Must stay the first import — see the helper.
import { restoreEnv } from './helpers/money.env';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { Decimal } from '../src/common/decimal';
import { PaymentsService } from '../src/payments/payments.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { SettlementsService } from '../src/settlements/settlements.service';
import { InboundOp } from '../src/stellar/matcher';

const IBAN = 'TR330006100519786457841326';

describe('Settlements, balance, withdrawals, payments (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let payments: PaymentsService;
  const email = `e2e-money-${Date.now()}@liralink.app`;
  let token: string;
  let merchantId: string;

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);

  /** Creates a link and records a full payment the way the listener does (emits payment.detected). */
  async function createPaidLink(amountTRY: string) {
    const res = await auth(http().post('/api/links'))
      .send({ title: `money ${amountTRY}`, amountTRY })
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
    await payments.recordPayment(
      link.id,
      link.merchantId,
      op,
      link.quotedUSDC,
      link.quotedUSDC,
      new Decimal(0),
      1,
    );
    return link;
  }

  async function balanceWhen(
    predicate: (b: Record<string, string>) => boolean,
  ): Promise<Record<string, string>> {
    for (let i = 0; i < 50; i++) {
      const res = await auth(http().get('/api/balance')).expect(200);
      const body = res.body as Record<string, string>;
      if (predicate(body)) return body;
      await sleep(100);
    }
    throw new Error('balance never reached the expected state');
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

    const authRes = await http()
      .post('/api/auth/register')
      .send({ email, password: 'demo1234', businessName: 'e2e money' });
    token = authRes.body.token;
    merchantId = authRes.body.merchant.id;
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

  it('starts at zero', async () => {
    const res = await auth(http().get('/api/balance')).expect(200);
    expect(res.body).toEqual({
      availableTRY: '0.00',
      pendingTRY: '0.00',
      paidOutTRY: '0.00',
      savedUSDC: '0.0000000',
      unallocatedUSDC: '0.0000000',
    });
  });

  it('settles a paid link for exactly its locked amountTRY', async () => {
    const link = await createPaidLink('340.00');
    const balance = await balanceWhen((b) => b.availableTRY === '340.00');
    expect(balance.pendingTRY).toBe('0.00');
    expect(balance.paidOutTRY).toBe('0.00');

    const settlements = await auth(http().get('/api/settlements')).expect(200);
    expect(settlements.body.total).toBe(1);
    expect(settlements.body.items[0]).toMatchObject({
      amountTRY: '340.00',
      amountUSDC: '10.0000000',
      savedUSDC: '0.0000000',
      feeUSDC: '0.0000000',
      netTRY: '340.00',
      provider: 'mock',
      status: 'completed',
    });
    expect(settlements.body.items[0].anchorRef).toMatch(/^mock-settle-/);

    const list = await auth(http().get('/api/payments')).expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]).toMatchObject({
      linkId: link.id,
      link: {
        code: link.code,
        title: 'money 340.00',
        amountTRY: '340.00',
        status: 'paid',
        quotedUSDC: '10.0000000',
        receivedUSDC: '10.0000000',
      },
      settlement: { status: 'completed', amountTRY: '340.00' },
    });
  });

  it('labels a partial payment in /payments with the link status and totals', async () => {
    const res = await auth(http().post('/api/links'))
      .send({ title: 'money partial', amountTRY: '340.00' })
      .expect(201);
    const link = await prisma.paymentLink.findUniqueOrThrow({
      where: { id: res.body.id as string },
    });
    const half = new Decimal('5.0000000');
    const op: InboundOp = {
      opId: `e2e-${randomBytes(8).toString('hex')}`,
      txHash: randomBytes(32).toString('hex'),
      from: 'GBRZSG7K6ZXJRCMYM2O2HO2DKR7RO2ACZ5FARBMQZBB4YZMDFDXFUTV7',
      to: 'GDWV6USF4R2ULWR5XW3TEUZSIRGRCU7PQWGSBDYJVIRFNAJ3LVNQ34N2',
      assetType: 'credit_alphanum4',
      assetCode: 'USDC',
      amount: half.toFixed(7),
      memoType: 'text',
      successful: true,
    };
    await payments.recordUnderpayment(
      link.id,
      op,
      half,
      half,
      link.quotedUSDC.minus(half),
      1,
    );

    const list = await auth(http().get('/api/payments')).expect(200);
    const row = (list.body.items as Record<string, unknown>[]).find(
      (i) => i.linkId === link.id,
    );
    expect(row).toMatchObject({
      amountUSDC: '5.0000000',
      link: {
        code: link.code,
        status: 'underpaid',
        quotedUSDC: '10.0000000',
        receivedUSDC: '5.0000000',
      },
      settlement: null,
    });
  });

  it('settling the same payment twice is a no-op', async () => {
    const before = await prisma.settlement.count({ where: { merchantId } });
    const payment = await prisma.payment.findFirstOrThrow({
      where: { link: { merchantId } },
    });
    await app.get(SettlementsService).settlePayment(payment.id);
    expect(await prisma.settlement.count({ where: { merchantId } })).toBe(
      before,
    );
  });

  it('requires an IBAN, rejects over-balance (422), and reserves the amount', async () => {
    await auth(http().post('/api/withdrawals'))
      .send({ amountTRY: '10.00' })
      .expect(400);
    await auth(http().post('/api/withdrawals'))
      .send({ amountTRY: '340.01', iban: IBAN })
      .expect(422);
    await auth(http().post('/api/withdrawals'))
      .send({ amountTRY: '0.00', iban: IBAN })
      .expect(400);

    const res = await auth(http().post('/api/withdrawals'))
      .send({ amountTRY: '100.00', iban: IBAN })
      .expect(201);
    expect(res.body).toMatchObject({ amountTRY: '100.00', iban: IBAN });

    await balanceWhen((b) => b.availableTRY === '240.00');
    for (let i = 0; i < 50; i++) {
      const list = await auth(http().get('/api/withdrawals')).expect(200);
      if (list.body.items[0].status === 'completed') break;
      await sleep(100);
    }
    const list = await auth(http().get('/api/withdrawals')).expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].status).toBe('completed');
    expect(list.body.items[0].anchorRef).toMatch(/^mock-payout-/);
  });

  it('never lets concurrent withdrawals overspend', async () => {
    await auth(http().patch('/api/me')).send({ iban: IBAN }).expect(200);
    const results = await Promise.all(
      [1, 2].map(() =>
        auth(http().post('/api/withdrawals')).send({ amountTRY: '200.00' }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    await balanceWhen((b) => b.availableTRY === '40.00');
  });

  it('applies autoSavePercent to later settlements', async () => {
    await auth(http().patch('/api/me'))
      .send({ autoSavePercent: 15 })
      .expect(200);
    await createPaidLink('340.00');
    const balance = await balanceWhen((b) => b.availableTRY === '329.00');
    expect(balance.savedUSDC).toBe('1.5000000');
  });
});
