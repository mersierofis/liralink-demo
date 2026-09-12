import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Auth + Merchants (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const email = `e2e-${Date.now()}@liralink.app`;
  const password = 'demo1234';

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
  });

  afterAll(async () => {
    await prisma.merchant.deleteMany({ where: { email } });
    await app.close();
  });

  let token: string;

  it('registers a merchant', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email, password, businessName: 'Erdemli Narenciye A.Ş.' })
      .expect(201);

    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.merchant).toMatchObject({
      email,
      businessName: 'Erdemli Narenciye A.Ş.',
    });
    expect(res.body.merchant.passwordHash).toBeUndefined();
  });

  it('rejects duplicate registration', () => {
    return request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email, password, businessName: 'dup' })
      .expect(409);
  });

  it('logs in', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password })
      .expect(200);

    token = res.body.token;
    expect(token).toEqual(expect.any(String));
  });

  it('rejects wrong password', () => {
    return request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'wrong-password' })
      .expect(401);
  });

  it('rejects /me without a token', () => {
    return request(app.getHttpServer()).get('/api/me').expect(401);
  });

  it('returns the merchant on /me with a token', () => {
    return request(app.getHttpServer())
      .get('/api/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.email).toBe(email);
        expect(res.body.settlementMode).toBe('balance');
      });
  });

  it('updates the merchant on PATCH /me', () => {
    return request(app.getHttpServer())
      .patch('/api/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ iban: 'TR330006100519786457841326', autoSavePercent: 15 })
      .expect(200)
      .expect((res) => {
        expect(res.body.iban).toBe('TR330006100519786457841326');
        expect(res.body.autoSavePercent).toBe(15);
      });
  });

  it('rejects an invalid iban on PATCH /me', () => {
    return request(app.getHttpServer())
      .patch('/api/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ iban: 'not-an-iban' })
      .expect(400);
  });
});
