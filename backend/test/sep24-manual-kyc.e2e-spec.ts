// Must stay the first import — see the helper.
import { restoreEnv, SEP24_MANUAL_KYC } from './helpers/sep24-manual-kyc.env';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { App } from 'supertest/types';
import { ANCHOR_ADAPTERS, AnchorAdapter } from '../src/anchor/anchor.adapter';
import { AppModule } from '../src/app.module';
import { Decimal } from '../src/common/decimal';
import { Settlement } from '../src/generated/prisma/client';
import { PaymentsService } from '../src/payments/payments.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { InboundOp } from '../src/stellar/matcher';

const IBAN = 'TR330006100519786457841326';
// Reconcile runs every minute; hold this long before handing out the URL so the waiting state is
// seen across several runs.
const HOLD_MS = 150_000;
const HUMAN_MS = 30 * 60_000;

// Live and manual: SEP-24 withdraw on testanchor.stellar.org with a person completing the interactive
// form, then a real 1 USDC payment. Run with
// `SEP24_MANUAL_KYC=1 [SEP24_URL_FILE=/path] npm run test:e2e -- sep24-manual-kyc`, open the printed
// URL (also written to SEP24_URL_FILE) and complete the form without changing the amount.
(SEP24_MANUAL_KYC ? describe : describe.skip)(
  'SEP-24 settlement with a human KYC step (e2e, live, manual)',
  () => {
    jest.setTimeout(HOLD_MS + HUMAN_MS + 10 * 60_000);

    let app: INestApplication<App>;
    let moduleFixture: TestingModule;
    let prisma: PrismaService;
    let payments: PaymentsService;
    const email = `e2e-sep24-kyc-${Date.now()}@liralink.app`;
    let token: string;
    let merchantId: string;

    const http = () => request(app.getHttpServer());
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);

    async function payLink(amountTRY: string) {
      const res = await auth(http().post('/api/links'))
        .send({ title: `sep24 manual kyc ${amountTRY}`, amountTRY })
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
      return payments.recordPayment(
        link.id,
        link.merchantId,
        op,
        link.quotedUSDC,
        link.quotedUSDC,
        new Decimal(0),
        1,
      );
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
        await sleep(3_000);
      }
      throw new Error(
        `settlement never reached the expected state; last: ${JSON.stringify(last)}`,
      );
    }

    /** The settlement as GET /settlements and GET /payments show it. */
    async function listed(settlementId: string, paymentId: string) {
      const settlements = await auth(http().get('/api/settlements')).expect(
        200,
      );
      const paymentsRes = await auth(http().get('/api/payments')).expect(200);
      return {
        settlement: (settlements.body.items as Record<string, unknown>[]).find(
          (i) => i.id === settlementId,
        ),
        payment: (paymentsRes.body.items as Record<string, unknown>[]).find(
          (i) => i.id === paymentId,
        ),
      };
    }

    beforeAll(async () => {
      moduleFixture = await Test.createTestingModule({
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
        .send({ email, password: 'demo1234', businessName: 'e2e sep24 kyc' })
        .expect(201);
      token = res.body.token as string;
      merchantId = res.body.merchant.id as string;
      await auth(http().patch('/api/me')).send({ iban: IBAN }).expect(200);
    });

    afterAll(async () => {
      if (merchantId) {
        await prisma.settlement.deleteMany({ where: { merchantId } });
        await prisma.payment.deleteMany({ where: { link: { merchantId } } });
        await prisma.paymentLink.deleteMany({ where: { merchantId } });
        await prisma.merchant.delete({ where: { id: merchantId } });
      }
      await app.close();
      restoreEnv();
    });

    it('waits in processing with interactiveUrl, then resumes on its own once the form is done', async () => {
      const adapter =
        moduleFixture.get<Record<string, AnchorAdapter>>(ANCHOR_ADAPTERS).sep24;
      const getTransaction = jest.spyOn(
        adapter as unknown as { getTransaction(id: string): Promise<unknown> },
        'getTransaction',
      );
      const errors = jest.spyOn(Logger.prototype, 'error');

      const payment = await payLink('34.00'); // 1 USDC at 34.00
      const s = await settlementWhen(
        payment.id,
        (x) => x.anchorStatus === 'incomplete',
        120_000,
      );
      expect(s).toMatchObject({
        provider: 'sep24',
        status: 'processing',
        blockedReason: null,
        failReason: null,
        anchorTxHash: null,
      });
      expect(s.interactiveUrl).toMatch(/^https:\/\//);

      // Hold across several reconcile runs: still waiting, one anchor poll per run, no errors.
      getTransaction.mockClear();
      errors.mockClear();
      await sleep(HOLD_MS);
      const held = await prisma.settlement.findUniqueOrThrow({
        where: { id: s.id },
      });
      expect(held).toMatchObject({
        status: 'processing',
        anchorStatus: 'incomplete',
        failReason: null,
        anchorTxHash: null,
      });
      const pollsWhileHeld = getTransaction.mock.calls.length;
      expect(pollsWhileHeld).toBeGreaterThanOrEqual(2);
      expect(pollsWhileHeld).toBeLessThanOrEqual(HOLD_MS / 60_000 + 1);
      expect(errors).not.toHaveBeenCalled();

      const shown = await listed(s.id, payment.id);
      expect(shown.settlement).toMatchObject({
        status: 'processing',
        interactiveUrl: s.interactiveUrl,
      });
      expect(shown.payment?.settlement).toMatchObject({
        id: s.id,
        status: 'processing',
        interactiveUrl: s.interactiveUrl,
      });

      if (process.env.SEP24_URL_FILE) {
        writeFileSync(process.env.SEP24_URL_FILE, `${s.interactiveUrl}\n`);
      }
      console.log(
        `\n\n=== Complete the anchor form (keep the amount):\n${s.interactiveUrl}\n\n`,
      );

      // The person completes the form; the job notices on its own.
      await settlementWhen(
        payment.id,
        (x) => x.anchorStatus !== 'incomplete' || x.status !== 'processing',
        HUMAN_MS,
      );
      const done = await settlementWhen(
        payment.id,
        (x) => x.status === 'completed' || x.status === 'failed',
        8 * 60_000,
      );
      expect(done).toMatchObject({ status: 'completed', failReason: null });
      expect(done.anchorTxHash).toMatch(/^[0-9a-f]{64}$/);
      expect(done.netTRY?.toFixed(2)).toBe('30.60');
      expect(
        errors.mock.calls.filter(([m]) => String(m).includes(s.id)),
      ).toEqual([]);

      const after = await listed(s.id, payment.id);
      expect(after.settlement).toMatchObject({
        status: 'completed',
        interactiveUrl: null,
      });
      expect(after.payment?.settlement).toMatchObject({ interactiveUrl: null });
    });
  },
);
