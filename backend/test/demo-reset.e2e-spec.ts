// Must stay the first import — see the helper.
import { restoreEnv } from './helpers/money.env';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { App } from 'supertest/types';
import { resetDemoMerchant } from '../scripts/demo-reset';
import { AppModule } from '../src/app.module';
import { Decimal } from '../src/common/decimal';
import { PrismaClient } from '../src/generated/prisma/client';
import { PaymentsService } from '../src/payments/payments.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { InboundOp } from '../src/stellar/matcher';

describe('demo:reset (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let payments: PaymentsService;
  const merchantIds: string[] = [];

  const http = () => request(app.getHttpServer());

  function op(amount: string): InboundOp {
    return {
      opId: `e2e-${randomBytes(8).toString('hex')}`,
      txHash: randomBytes(32).toString('hex'),
      from: 'GBRZSG7K6ZXJRCMYM2O2HO2DKR7RO2ACZ5FARBMQZBB4YZMDFDXFUTV7',
      to: 'GDWV6USF4R2ULWR5XW3TEUZSIRGRCU7PQWGSBDYJVIRFNAJ3LVNQ34N2',
      assetType: 'credit_alphanum4',
      assetCode: 'USDC',
      amount,
      memoType: 'text',
      successful: true,
    };
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
  });

  afterAll(async () => {
    await prisma.withdrawal.deleteMany({
      where: { merchantId: { in: merchantIds } },
    });
    await prisma.settlement.deleteMany({
      where: { merchantId: { in: merchantIds } },
    });
    await prisma.payment.deleteMany({
      where: { link: { merchantId: { in: merchantIds } } },
    });
    await prisma.paymentLink.deleteMany({
      where: { merchantId: { in: merchantIds } },
    });
    await prisma.merchant.deleteMany({ where: { id: { in: merchantIds } } });
    await app.close();
    restoreEnv();
  });

  async function waitFor(check: () => Promise<boolean>) {
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await sleep(50);
    }
    throw new Error('timed out');
  }

  it('deletes mock withdrawals, completes and creates mock settlements, and is idempotent', async () => {
    const reg = await http()
      .post('/api/auth/register')
      .send({
        email: `e2e-demoreset-${Date.now()}@liralink.app`,
        password: 'demo1234',
        businessName: 'e2e demo reset',
      })
      .expect(201);
    const merchantId = reg.body.merchant.id as string;
    merchantIds.push(merchantId);
    const auth = (r: request.Test) =>
      r.set('Authorization', `Bearer ${reg.body.token as string}`);

    async function paidLink() {
      const res = await auth(http().post('/api/links'))
        .send({ title: 'demo reset', amountTRY: '34.00' }) // 1 USDC at 34.00
        .expect(201);
      const link = await prisma.paymentLink.findUniqueOrThrow({
        where: { id: res.body.id as string },
      });
      await payments.recordPayment(
        link.id,
        merchantId,
        op('1.0000000'),
        new Decimal(1),
        new Decimal(1),
        new Decimal(0),
        1,
      );
      return link;
    }

    // Three paid links, settled by the app (mock anchor, 50 ms).
    const [a, b, c] = [await paidLink(), await paidLink(), await paidLink()];
    await waitFor(async () => {
      const n = await prisma.settlement.count({
        where: { merchantId, status: 'completed' },
      });
      return n === 3;
    });

    // Panel test withdrawal, completed by the mock payout.
    const wd = await auth(http().post('/api/withdrawals'))
      .send({ amountTRY: '60.00', iban: 'TR420015666666666666666666' })
      .expect(201);
    await waitFor(async () => {
      const w = await prisma.withdrawal.findUniqueOrThrow({
        where: { id: wd.body.id as string },
      });
      return w.status === 'completed';
    });

    // Damage the ledger: b's settlement failed, c's settlement missing.
    const sB = await prisma.settlement.findFirstOrThrow({
      where: { payment: { linkId: b.id } },
    });
    await prisma.settlement.update({
      where: { id: sB.id },
      data: { status: 'failed', failReason: 'anchor_status' },
    });
    await prisma.settlement.deleteMany({
      where: { payment: { linkId: c.id } },
    });
    const before = await auth(http().get('/api/balance')).expect(200);
    expect(before.body.availableTRY).toBe('-26.00'); // 34 − 60

    const client = prisma as unknown as PrismaClient;

    // Dry run writes nothing.
    const dry = await resetDemoMerchant(client, merchantId, { dryRun: true });
    expect(dry.deletedWithdrawals).toHaveLength(1);
    expect(await prisma.withdrawal.count({ where: { merchantId } })).toBe(1);

    const first = await resetDemoMerchant(client, merchantId);
    expect(first.deletedWithdrawals.map((w) => w.id)).toEqual([wd.body.id]);
    expect(first.completedSettlements).toEqual([
      { id: sB.id, linkCode: b.code, previousStatus: 'failed' },
    ]);
    expect(first.createdSettlements.map((s) => s.linkCode)).toEqual([c.code]);
    expect(first.availableTRY).toBe('102.00');
    expect(first.completedNetTRY).toBe('102.00');

    const after = await auth(http().get('/api/balance')).expect(200);
    expect(after.body.availableTRY).toBe('102.00');
    // Links, payments and settlements of a are untouched.
    expect(await prisma.payment.count({ where: { linkId: a.id } })).toBe(1);

    const second = await resetDemoMerchant(client, merchantId);
    expect(second.deletedWithdrawals).toEqual([]);
    expect(second.completedSettlements).toEqual([]);
    expect(second.createdSettlements).toEqual([]);
    expect(second.availableTRY).toBe('102.00');
  });
});
