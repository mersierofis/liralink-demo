// Must stay the first import — see the helper.
import { restoreEnv } from './helpers/auto-payout.env';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const IBAN = 'TR330006100519786457841326';
const PAYER = 'GBRZSG7K6ZXJRCMYM2O2HO2DKR7RO2ACZ5FARBMQZBB4YZMDFDXFUTV7';

describe('auto_payout settlement mode (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const email = `e2e-autopayout-${Date.now()}@liralink.app`;
  let token: string;
  let merchantId: string;

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);

  /** A link with one payment and a settlement in the given state — no anchor involved. */
  async function settledLink(data: {
    provider: string;
    amountTRY: string;
    amountUSDC: string;
    feeUSDC: string | null;
    netTRY: string | null;
  }) {
    const link = await auth(http().post('/api/links'))
      .send({
        title: `auto payout ${data.amountTRY}`,
        amountTRY: data.amountTRY,
      })
      .expect(201);
    const payment = await prisma.payment.create({
      data: {
        linkId: link.body.id as string,
        txHash: randomBytes(32).toString('hex'),
        payerAddress: PAYER,
        amountUSDC: data.amountUSDC,
        ledger: 1,
      },
    });
    return prisma.settlement.create({
      data: {
        merchantId,
        paymentId: payment.id,
        amountUSDC: data.amountUSDC,
        amountTRY: data.amountTRY,
        fxRate: '34.0000000',
        provider: data.provider,
        status: 'completed',
        feeUSDC: data.feeUSDC,
        netTRY: data.netTRY,
        anchorRef: `e2e-${data.provider}`,
        completedAt: new Date(),
      },
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
    await app.init();

    const res = await http()
      .post('/api/auth/register')
      .send({ email, password: 'demo1234', businessName: 'e2e auto payout' })
      .expect(201);
    token = res.body.token as string;
    merchantId = res.body.merchant.id as string;
    expect(res.body.merchant.settlementMode).toBe('auto_payout');
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

  it('reports auto_payout on /me and /health', async () => {
    const me = await auth(http().get('/api/me')).expect(200);
    expect(me.body.settlementMode).toBe('auto_payout');
    const health = await http().get('/api/health').expect(200);
    expect(health.body).toMatchObject({
      anchor: 'sep24',
      settlementMode: 'auto_payout',
    });
  });

  it('refuses withdrawals with 409', async () => {
    const res = await auth(http().post('/api/withdrawals'))
      .send({ amountTRY: '10.00', iban: IBAN })
      .expect(409);
    expect(res.body.message).toBe('Payouts are automatic in this mode');
    expect(await prisma.withdrawal.count({ where: { merchantId } })).toBe(0);
  });

  it('puts completed sep24 settlements in paidOutTRY by netTRY, never availableTRY', async () => {
    const s = await settledLink({
      provider: 'sep24',
      amountTRY: '34.00',
      amountUSDC: '1.0000000',
      feeUSDC: '0.1000000',
      netTRY: '30.60',
    });
    const balance = await auth(http().get('/api/balance')).expect(200);
    expect(balance.body).toMatchObject({
      availableTRY: '0.00',
      pendingTRY: '0.00',
      paidOutTRY: '30.60',
    });
    const list = await auth(http().get('/api/settlements')).expect(200);
    expect(
      (list.body.items as Record<string, unknown>[]).find((i) => i.id === s.id),
    ).toMatchObject({ feeUSDC: '0.1000000', netTRY: '30.60' });
  });

  it('keeps a mock settlement in availableTRY (bucket follows the provider); legacy null net = gross', async () => {
    const s = await settledLink({
      provider: 'mock',
      amountTRY: '10.00',
      amountUSDC: '0.2941176',
      feeUSDC: null,
      netTRY: null,
    });
    const balance = await auth(http().get('/api/balance')).expect(200);
    expect(balance.body).toMatchObject({
      availableTRY: '10.00',
      paidOutTRY: '30.60',
    });
    const list = await auth(http().get('/api/settlements')).expect(200);
    expect(
      (list.body.items as Record<string, unknown>[]).find((i) => i.id === s.id),
    ).toMatchObject({ feeUSDC: '0.0000000', netTRY: '10.00' });
  });
});
