// Must stay the first import — see the helper.
import { restoreEnv } from './helpers/money.env';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Horizon, Keypair } from '@stellar/stellar-sdk';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { Decimal } from '../src/common/decimal';
import { PrismaService } from '../src/prisma/prisma.service';

// Opt-in, real testnet: USDC_WD_E2E=1 USDC_WD_E2E_DESTINATION=G… npm run test:e2e -- usdc-withdrawals-live
// Sends 0.0100000 USDC from the platform account to the destination (which must trust USDC), and
// checks the 422s against a real unfunded account and a freshly funded one without a trustline.
const LIVE = process.env.USDC_WD_E2E === '1';
const DESTINATION = process.env.USDC_WD_E2E_DESTINATION ?? '';

(LIVE ? describe : describe.skip)(
  'USDC withdrawals (e2e, live testnet)',
  () => {
    let app: INestApplication<App>;
    let prisma: PrismaService;
    let token: string;
    let merchantId: string;
    const horizon = new Horizon.Server(
      process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org',
    );

    const http = () => request(app.getHttpServer());
    const post = (body: Record<string, string>) =>
      http()
        .post('/api/usdc-withdrawals')
        .set('Authorization', `Bearer ${token}`)
        .send(body);

    beforeAll(async () => {
      if (!/^G[A-Z2-7]{55}$/.test(DESTINATION)) {
        throw new Error(
          'USDC_WD_E2E_DESTINATION must be a G… address that trusts USDC',
        );
      }
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
        .send({
          email: `e2e-usdcwd-live-${Date.now()}@liralink.app`,
          password: 'demo1234',
          businessName: 'e2e usdc wd live',
        })
        .expect(201);
      token = res.body.token;
      merchantId = res.body.merchant.id;
      await prisma.merchant.update({
        where: { id: merchantId },
        data: { unallocatedUSDC: new Decimal('0.0100000') },
      });
    }, 30_000);

    afterAll(async () => {
      if (merchantId) {
        await prisma.usdcWithdrawal.deleteMany({ where: { merchantId } });
        await prisma.merchant.delete({ where: { id: merchantId } });
      }
      await app?.close();
      restoreEnv();
    });

    it('422: the destination account does not exist', async () => {
      const res = await post({
        amountUSDC: '0.0100000',
        destination: Keypair.random().publicKey(),
        source: 'unallocated',
      }).expect(422);
      expect(res.body.message).toMatch(/does not exist on the Stellar testnet/);
    }, 30_000);

    it('422: the destination exists but has no USDC trustline', async () => {
      const fresh = Keypair.random();
      await fetch(`https://friendbot.stellar.org/?addr=${fresh.publicKey()}`);
      const res = await post({
        amountUSDC: '0.0100000',
        destination: fresh.publicKey(),
        source: 'unallocated',
      }).expect(422);
      expect(res.body.message).toMatch(/has no USDC trustline/);
    }, 60_000);

    it('sends 0.0100000 USDC on testnet and the tx is on the ledger', async () => {
      const res = await post({
        amountUSDC: '0.0100000',
        destination: DESTINATION,
        source: 'unallocated',
      }).expect(201);
      expect(res.body.status).toBe('completed');
      console.log(`live USDC withdrawal tx ${res.body.txHash as string}`);

      const tx = await horizon
        .transactions()
        .transaction(res.body.txHash as string)
        .call();
      expect(tx.successful).toBe(true);
      const merchant = await prisma.merchant.findUniqueOrThrow({
        where: { id: merchantId },
      });
      expect(merchant.unallocatedUSDC.toFixed(7)).toBe('0.0000000');
    }, 60_000);
  },
);
