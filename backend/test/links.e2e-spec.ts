import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Links (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const email = `e2e-links-${Date.now()}@liralink.app`;
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

    const res = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({
        email,
        password: 'demo1234',
        businessName: 'e2e links merchant',
      });
    token = res.body.token;
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

  let linkId: string;

  it('creates a link with a correctly rounded quote', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/links')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Lemon order #1042', amountTRY: '340.00' })
      .expect(201);

    linkId = res.body.id;
    expect(res.body.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    expect(res.body.quotedUSDC).toBe('10.0000000');
    expect(res.body.status).toBe('open');
    expect(res.body.payUrl).toContain(res.body.code);
  });

  it('rejects an amount below the minimum', () => {
    return request(app.getHttpServer())
      .post('/api/links')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'too small', amountTRY: '0.50' })
      .expect(400);
  });

  it('rejects a malformed amount string', () => {
    return request(app.getHttpServer())
      .post('/api/links')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'bad format', amountTRY: '5000' })
      .expect(400);
  });

  it('lists the created link', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/links')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.items.some((l: { id: string }) => l.id === linkId)).toBe(
      true,
    );
  });

  it('filters the list by status', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/links?status=open')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(
      res.body.items.every((l: { status: string }) => l.status === 'open'),
    ).toBe(true);
  });

  it('gets a single link by id', () => {
    return request(app.getHttpServer())
      .get(`/api/links/${linkId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.id).toBe(linkId);
      });
  });

  it("404s on another merchant's / unknown link id", () => {
    return request(app.getHttpServer())
      .get('/api/links/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('cancels an open link', () => {
    return request(app.getHttpServer())
      .post(`/api/links/${linkId}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.status).toBe('cancelled');
      });
  });

  it('rejects cancelling an already-cancelled link with 409', () => {
    return request(app.getHttpServer())
      .post(`/api/links/${linkId}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
  });
});
