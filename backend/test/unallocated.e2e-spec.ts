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
import { InboundOp } from '../src/stellar/matcher';

describe('GET /unallocated (e2e)', () => {
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

  async function register(label: string) {
    const res = await http()
      .post('/api/auth/register')
      .send({
        email: `e2e-unalloc-${label}-${Date.now()}@liralink.app`,
        password: 'demo1234',
        businessName: `e2e unallocated ${label}`,
      })
      .expect(201);
    merchantIds.push(res.body.merchant.id as string);
    return res.body.token as string;
  }

  async function createLink(token: string) {
    const res = await http()
      .post('/api/links')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'unallocated', amountTRY: '34.00' }) // 1 USDC at 34.00
      .expect(201);
    return prisma.paymentLink.findUniqueOrThrow({
      where: { id: res.body.id as string },
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
    await app.init();
  });

  afterAll(async () => {
    const links = await prisma.paymentLink.findMany({
      where: { merchantId: { in: merchantIds } },
    });
    await prisma.usdcWithdrawal.deleteMany({
      where: { merchantId: { in: merchantIds } },
    });
    await prisma.paymentAttempt.deleteMany({
      where: { linkCode: { in: links.map((l) => l.code) } },
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

  it('401 without a token', async () => {
    await http().get('/api/unallocated').expect(401);
  });

  it('lists overpayment excess and stray payments, newest first, summing to unallocatedUSDC', async () => {
    const token = await register('a');
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);

    // Overpaid: 1.5 USDC for a 1 USDC link → 0.5 excess.
    const overpaid = await createLink(token);
    const overpay = op('1.5000000');
    await payments.recordPayment(
      overpaid.id,
      overpaid.merchantId,
      overpay,
      new Decimal('1.5'),
      new Decimal('1.5'),
      new Decimal('0.5'),
      1,
    );
    await sleep(10);

    // Stray: 2 USDC to a link that is already paid.
    const paid = await createLink(token);
    await payments.recordPayment(
      paid.id,
      paid.merchantId,
      op('1.0000000'),
      new Decimal('1'),
      new Decimal('1'),
      new Decimal(0),
      1,
    );
    const stray = op('2.0000000');
    await payments.recordStray(
      paid.id,
      paid.merchantId,
      stray,
      paid.code,
      new Decimal('2'),
      'link status is "paid"',
    );
    // Not credited → not listed.
    await payments.recordAttempt(op('9.0000000'), paid.code, 'wrong asset');

    // Another merchant's stray → not listed.
    const other = await register('b');
    const otherLink = await createLink(other);
    await payments.recordStray(
      otherLink.id,
      otherLink.merchantId,
      op('4.0000000'),
      otherLink.code,
      new Decimal('4'),
      'link status is "expired"',
    );

    const res = await auth(http().get('/api/unallocated')).expect(200);
    expect(res.body.total).toBe(2);
    expect(res.body.items).toEqual([
      {
        id: expect.any(String) as string,
        source: 'stray',
        txHash: stray.txHash,
        explorerUrl: `https://stellar.expert/explorer/testnet/tx/${stray.txHash}`,
        amountUSDC: '2.0000000',
        linkCode: paid.code,
        reason: 'link status is "paid"',
        createdAt: expect.any(String) as string,
      },
      {
        id: expect.any(String) as string,
        source: 'overpaid',
        txHash: overpay.txHash,
        explorerUrl: `https://stellar.expert/explorer/testnet/tx/${overpay.txHash}`,
        amountUSDC: '0.5000000',
        linkCode: overpaid.code,
        reason: 'received 1.5000000 of 1.0000000 USDC quoted',
        createdAt: expect.any(String) as string,
      },
    ]);

    const balance = await auth(http().get('/api/balance')).expect(200);
    const sum = (res.body.items as { amountUSDC: string }[]).reduce(
      (acc, i) => acc.plus(i.amountUSDC),
      new Decimal(0),
    );
    expect(sum.toFixed(7)).toBe(balance.body.unallocatedUSDC);
    expect(res.body.summary).toEqual({
      creditedUSDC: '2.5000000',
      withdrawnUSDC: '0.0000000',
      remainingUSDC: '2.5000000',
    });

    const page2 = await auth(
      http().get('/api/unallocated?page=2&limit=1'),
    ).expect(200);
    expect(page2.body.total).toBe(2);
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.items[0].source).toBe('overpaid');
    // The summary covers every page, not the one returned.
    expect(page2.body.summary).toEqual(res.body.summary);

    // USDC sent out from 'unallocated': non-failed rows count, failed ones don't.
    const merchantId = merchantIds[0];
    for (const [amount, status] of [
      ['0.7000000', 'completed'],
      ['0.3000000', 'submitted'],
      ['1.0000000', 'failed'],
    ] as const) {
      await prisma.usdcWithdrawal.create({
        data: {
          merchantId,
          amountUSDC: new Decimal(amount),
          destination:
            'GBRZSG7K6ZXJRCMYM2O2HO2DKR7RO2ACZ5FARBMQZBB4YZMDFDXFUTV7',
          source: 'unallocated',
          status,
          txHash: randomBytes(32).toString('hex'),
          txXdr: 'unused',
        },
      });
    }
    // A 'saved' withdrawal is not this balance's.
    await prisma.usdcWithdrawal.create({
      data: {
        merchantId,
        amountUSDC: new Decimal('0.1'),
        destination: 'GBRZSG7K6ZXJRCMYM2O2HO2DKR7RO2ACZ5FARBMQZBB4YZMDFDXFUTV7',
        source: 'saved',
        txHash: randomBytes(32).toString('hex'),
        txXdr: 'unused',
      },
    });
    // The service debits the stored counter in the same tx; mirror that here.
    await prisma.merchant.update({
      where: { id: merchantId },
      data: { unallocatedUSDC: { decrement: new Decimal('1.0') } },
    });

    const after = await auth(http().get('/api/unallocated')).expect(200);
    expect(after.body.summary).toEqual({
      creditedUSDC: '2.5000000',
      withdrawnUSDC: '1.0000000',
      remainingUSDC: '1.5000000',
    });
    const balanceAfter = await auth(http().get('/api/balance')).expect(200);
    expect(after.body.summary.remainingUSDC).toBe(
      balanceAfter.body.unallocatedUSDC,
    );
  });
});
