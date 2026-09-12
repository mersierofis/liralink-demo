// Must stay the first import — see the helper.
import { restoreEnv } from './helpers/onchain-rpc-down.env';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Links on-chain best-effort (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const email = `e2e-onchain-${Date.now()}@liralink.app`;
  let token: string;

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

    const authRes = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email, password: 'demo1234', businessName: 'e2e onchain' });
    token = authRes.body.token;
  });

  afterAll(async () => {
    const merchant = await prisma.merchant.findUnique({ where: { email } });
    if (merchant) {
      await prisma.paymentLink.deleteMany({
        where: { merchantId: merchant.id },
      });
      await prisma.merchant.delete({ where: { id: merchant.id } });
    }
    await app.close();
    restoreEnv();
  });

  it('still creates the link (201, onchain null) when RPC fails, and the retry surfaces the error', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/links')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'RPC down', amountTRY: '340.00' })
      .expect(201);

    expect(res.body.onchain).toBeNull();
    expect(res.body.quotedUSDC).toBe('10.0000000');

    const quote = await request(app.getHttpServer())
      .get(`/api/pay/${res.body.code}`)
      .expect(200);
    expect(quote.body.rails.contract).toBeUndefined();
    expect(quote.body.rails.memo.memo).toBe(res.body.code);

    const retry = await request(app.getHttpServer())
      .post(`/api/links/${res.body.id}/onchain`)
      .set('Authorization', `Bearer ${token}`);
    expect(retry.status).toBeGreaterThanOrEqual(500);

    const after = await prisma.paymentLink.findUniqueOrThrow({
      where: { id: res.body.id },
    });
    expect(after.contractId).toBeNull();
  });

  it('re-quotes an off-chain link after its quote expires', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/links')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Stale quote', amountTRY: '340.00' })
      .expect(201);
    const stale = new Date(Date.now() - 60_000);
    await prisma.paymentLink.update({
      where: { id: res.body.id },
      data: { quoteExpiresAt: stale },
    });

    const quote = await request(app.getHttpServer())
      .get(`/api/pay/${res.body.code}`)
      .expect(200);
    const quoteExpiresAt = new Date(quote.body.quoteExpiresAt as string);
    expect(quoteExpiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
