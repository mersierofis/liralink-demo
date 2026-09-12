import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Pay (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const email = `e2e-pay-${Date.now()}@liralink.app`;
  let token: string;
  let code: string;

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
      .send({ email, password: 'demo1234', businessName: 'e2e pay merchant' });
    token = authRes.body.token;

    const linkRes = await request(app.getHttpServer())
      .post('/api/links')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Pay flow test', amountTRY: '340.00' });
    code = linkRes.body.code;
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
  });

  it('returns a public quote with no auth required', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/pay/${code}`)
      .expect(200);

    expect(res.body).toMatchObject({
      code,
      amountTRY: '340.00',
      amountUSDC: '10.0000000',
      status: 'open',
      rails: { memo: { memo: code } },
      network: 'testnet',
    });
    expect(res.body.rails.memo.destination).toMatch(/^G[A-Z0-9]{55}$/);
    expect(res.body.asset).toEqual({
      code: 'USDC',
      issuer: expect.any(String),
    });
    expect(res.body.payment).toBeUndefined();
  });

  it('accepts a lowercase code (case-insensitive lookup)', () => {
    return request(app.getHttpServer())
      .get(`/api/pay/${code.toLowerCase()}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.code).toBe(code);
      });
  });

  it('404s on an unknown code', () => {
    return request(app.getHttpServer()).get('/api/pay/ZZZZZZZZ').expect(404);
  });

  it('returns open status with no payment yet', () => {
    return request(app.getHttpServer())
      .get(`/api/pay/${code}/status`)
      .expect(200)
      .expect((res) => {
        expect(res.body.status).toBe('open');
        expect(res.body.payment).toBeUndefined();
      });
  });

  it('404s on status for an unknown code', () => {
    return request(app.getHttpServer())
      .get('/api/pay/ZZZZZZZZ/status')
      .expect(404);
  });

  it('accepts a submitted hint and always returns 202', () => {
    return request(app.getHttpServer())
      .post(`/api/pay/${code}/submitted`)
      .send({ txHash: 'deadbeef'.repeat(8) })
      .expect(202)
      .expect((res) => {
        expect(res.body).toEqual({ accepted: true });
      });
  });

  it('404s a submitted hint for an unknown code', () => {
    return request(app.getHttpServer())
      .post('/api/pay/ZZZZZZZZ/submitted')
      .send({ txHash: 'deadbeef'.repeat(8) })
      .expect(404);
  });

  it('rejects a submitted hint with no txHash', () => {
    return request(app.getHttpServer())
      .post(`/api/pay/${code}/submitted`)
      .send({})
      .expect(400);
  });
});
