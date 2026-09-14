// Must stay the first import — see the helper.
import { restoreEnv } from './helpers/money.env';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  Account,
  Keypair,
  Networks,
  Operation,
  Asset,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { Decimal } from '../src/common/decimal';
import { PaymentsService } from '../src/payments/payments.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { InboundOp } from '../src/stellar/matcher';
import { StellarService } from '../src/stellar/stellar.service';
import { UsdcWithdrawalsService } from '../src/usdc-withdrawals/usdc-withdrawals.service';

// Horizon is stubbed on the StellarService instance: this spec is about the debit, the persisted
// signed transaction and the retry path. usdc-withdrawals-live.e2e-spec.ts sends a real payment.
describe('USDC withdrawals (e2e, Horizon stubbed)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let payments: PaymentsService;
  let stellar: StellarService;
  let service: UsdcWithdrawalsService;
  const email = `e2e-usdcwd-${Date.now()}@liralink.app`;
  let token: string;
  let merchantId: string;
  const destination = Keypair.random().publicKey();

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
  const post = (body: Record<string, string>) =>
    auth(http().post('/api/usdc-withdrawals')).send(body);
  const balance = async () =>
    (await auth(http().get('/api/balance')).expect(200)).body as Record<
      string,
      string
    >;

  // A real signed transaction (random source, never submitted) — each call a distinct hash.
  let seq = 1;
  const signer = Keypair.random();
  function fakeSigned(dest: string, amount: string) {
    const tx = new TransactionBuilder(
      new Account(signer.publicKey(), String(seq++)),
      { fee: '100', networkPassphrase: Networks.TESTNET },
    )
      .addOperation(
        Operation.payment({
          destination: dest,
          asset: new Asset('USDC', Keypair.random().publicKey()),
          amount,
        }),
      )
      .setTimeout(120)
      .build();
    tx.sign(signer);
    return Promise.resolve(tx);
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
    stellar = moduleFixture.get(StellarService);
    service = moduleFixture.get(UsdcWithdrawalsService);
    await app.init();

    const authRes = await http()
      .post('/api/auth/register')
      .send({ email, password: 'demo1234', businessName: 'e2e usdc wd' })
      .expect(201);
    token = authRes.body.token;
    merchantId = authRes.body.merchant.id;
  });

  beforeEach(() => {
    jest.spyOn(stellar, 'usdcDestinationProblem').mockResolvedValue(null);
    jest.spyOn(stellar, 'buildUsdcPayment').mockImplementation(fakeSigned);
    jest.spyOn(stellar, 'findTransaction').mockResolvedValue(null);
    jest.spyOn(stellar, 'expired').mockResolvedValue(false);
    jest.spyOn(stellar, 'submitSigned').mockResolvedValue(undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    if (merchantId) {
      await prisma.usdcWithdrawal.deleteMany({ where: { merchantId } });
      await prisma.settlement.deleteMany({ where: { merchantId } });
      await prisma.payment.deleteMany({ where: { link: { merchantId } } });
      await prisma.paymentLink.deleteMany({ where: { merchantId } });
      await prisma.merchant.delete({ where: { id: merchantId } });
    }
    await app.close();
    restoreEnv();
  });

  it('401 without a token', async () => {
    await http().post('/api/usdc-withdrawals').send({}).expect(401);
    await http().get('/api/usdc-withdrawals').expect(401);
  });

  it.each([
    [{ amountUSDC: '1.00', destination, source: 'saved' }, 'amountUSDC'],
    [
      { amountUSDC: '1.0000000', destination: 'GABC', source: 'saved' },
      'destination',
    ],
    [{ amountUSDC: '1.0000000', destination, source: 'wallet' }, 'source'],
  ])('400 on a bad body (%o)', async (body, field) => {
    const res = await post(body).expect(400);
    expect(JSON.stringify(res.body.message)).toContain(field);
  });

  it('422 with the plain message when the destination has no USDC trustline', async () => {
    await prisma.merchant.update({
      where: { id: merchantId },
      data: { unallocatedUSDC: new Decimal('5') },
    });
    const message = `Destination ${destination} has no USDC trustline — add USDC (issuer X) in the wallet first`;
    jest.spyOn(stellar, 'usdcDestinationProblem').mockResolvedValue(message);

    const res = await post({
      amountUSDC: '1.0000000',
      destination,
      source: 'unallocated',
    }).expect(422);
    expect(res.body.message).toBe(message);
    expect((await balance()).unallocatedUSDC).toBe('5.0000000');
  });

  it('sends from unallocatedUSDC: debits it, returns the tx, lists it', async () => {
    const res = await post({
      amountUSDC: '1.2500000',
      destination,
      source: 'unallocated',
    }).expect(201);

    expect(res.body).toMatchObject({
      merchantId,
      amountUSDC: '1.2500000',
      destination,
      source: 'unallocated',
      status: 'completed',
      failReason: null,
    });
    expect(res.body.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.explorerUrl).toBe(
      `https://stellar.expert/explorer/testnet/tx/${res.body.txHash}`,
    );
    expect(res.body.completedAt).toEqual(expect.any(String));
    expect(res.body).not.toHaveProperty('txXdr');
    expect((await balance()).unallocatedUSDC).toBe('3.7500000');

    const list = await auth(http().get('/api/usdc-withdrawals')).expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].id).toBe(res.body.id);
  });

  it('422 when the amount exceeds the source balance', async () => {
    const res = await post({
      amountUSDC: '3.7500001',
      destination,
      source: 'unallocated',
    }).expect(422);
    expect(res.body.message).toBe(
      'amountUSDC 3.7500001 exceeds unallocatedUSDC 3.7500000',
    );
  });

  it('two concurrent requests cannot spend the same balance', async () => {
    const [a, b] = await Promise.all([
      post({ amountUSDC: '3.0000000', destination, source: 'unallocated' }),
      post({ amountUSDC: '3.0000000', destination, source: 'unallocated' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 422]);
    expect((await balance()).unallocatedUSDC).toBe('0.7500000');
  });

  it('sends from savedUSDC (auto-save settlements), net of earlier withdrawals', async () => {
    await auth(http().patch('/api/me'))
      .send({ autoSavePercent: 10 })
      .expect(200);
    const created = await auth(http().post('/api/links'))
      .send({ title: 'usdc wd saved', amountTRY: '340.00' }) // 10 USDC → 1 saved
      .expect(201);
    const link = await prisma.paymentLink.findUniqueOrThrow({
      where: { id: created.body.id as string },
    });
    const op: InboundOp = {
      opId: `e2e-${randomBytes(8).toString('hex')}`,
      txHash: randomBytes(32).toString('hex'),
      from: Keypair.random().publicKey(),
      to: stellar.platformPublicKey,
      assetType: 'credit_alphanum4',
      assetCode: 'USDC',
      amount: link.quotedUSDC.toFixed(7),
      memoType: 'text',
      successful: true,
    };
    await payments.recordPayment(
      link.id,
      merchantId,
      op,
      link.quotedUSDC,
      link.quotedUSDC,
      new Decimal(0),
      1,
    );
    for (
      let i = 0;
      i < 50 && (await balance()).savedUSDC === '0.0000000';
      i++
    ) {
      await sleep(100);
    }
    expect((await balance()).savedUSDC).toBe('1.0000000');

    await post({
      amountUSDC: '0.4000000',
      destination,
      source: 'saved',
    }).expect(201);
    const after = await balance();
    expect(after.savedUSDC).toBe('0.6000000');
    expect(after.unallocatedUSDC).toBe('0.7500000');

    const res = await post({
      amountUSDC: '0.7000000',
      destination,
      source: 'saved',
    }).expect(422);
    expect(res.body.message).toBe(
      'amountUSDC 0.7000000 exceeds savedUSDC 0.6000000',
    );
  });

  it('a failed submit stays submitted and is retried with the SAME signed transaction', async () => {
    jest
      .spyOn(stellar, 'submitSigned')
      .mockRejectedValueOnce(new Error('timeout'));
    const res = await post({
      amountUSDC: '0.5000000',
      destination,
      source: 'unallocated',
    }).expect(201);
    expect(res.body.status).toBe('submitted');
    expect((await balance()).unallocatedUSDC).toBe('0.2500000'); // debited while in flight

    // The minute job skips rows younger than 30 s — age it.
    await prisma.usdcWithdrawal.update({
      where: { id: res.body.id as string },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });
    // spyOn on an already-spied method returns the same mock — drop the POST's own calls.
    const submit = jest
      .spyOn(stellar, 'submitSigned')
      .mockClear()
      .mockResolvedValue(undefined);
    const build = jest.spyOn(stellar, 'buildUsdcPayment').mockClear();
    await service.reconcile();

    expect(build).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0].hash().toString('hex')).toBe(
      res.body.txHash,
    );
    const row = await prisma.usdcWithdrawal.findUniqueOrThrow({
      where: { id: res.body.id as string },
    });
    expect(row.status).toBe('completed');
    expect((await balance()).unallocatedUSDC).toBe('0.2500000');
  });

  it('an expired transaction that never landed fails and gives the amount back', async () => {
    jest
      .spyOn(stellar, 'submitSigned')
      .mockRejectedValue(new Error('tx_bad_seq'));
    const res = await post({
      amountUSDC: '0.2500000',
      destination,
      source: 'unallocated',
    }).expect(201);
    expect(res.body.status).toBe('submitted');
    expect((await balance()).unallocatedUSDC).toBe('0.0000000');

    await prisma.usdcWithdrawal.update({
      where: { id: res.body.id as string },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });
    jest.spyOn(stellar, 'expired').mockResolvedValue(true);
    await service.reconcile();
    await service.reconcile(); // a second run must not release it twice

    // Backdated above, so it isn't the newest row any more — find it by id.
    const list = await auth(http().get('/api/usdc-withdrawals')).expect(200);
    expect(
      list.body.items.find((w: { id: string }) => w.id === res.body.id),
    ).toMatchObject({
      id: res.body.id,
      status: 'failed',
      failReason: 'expired_unsubmitted',
    });
    expect((await balance()).unallocatedUSDC).toBe('0.2500000');
  });

  it('paginates newest first', async () => {
    const all = await auth(http().get('/api/usdc-withdrawals')).expect(200);
    expect(all.body.total).toBe(5);
    const page2 = await auth(
      http().get('/api/usdc-withdrawals?page=2&limit=2'),
    ).expect(200);
    expect(page2.body.items.map((w: { id: string }) => w.id)).toEqual(
      all.body.items.slice(2, 4).map((w: { id: string }) => w.id),
    );
  });
});
