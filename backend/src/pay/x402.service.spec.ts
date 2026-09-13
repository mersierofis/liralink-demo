import { ConflictException, Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Asset, Networks } from '@stellar/stellar-sdk';
import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';
import { FacilitatorTimeoutError } from '@x402/core/server';
import type { FacilitatorClient } from '@x402/core/server';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { Decimal } from '../common/decimal';
import type { PaymentsService } from '../payments/payments.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { StellarService } from '../stellar/stellar.service';
import type { PayService } from './pay.service';
import { X402_NETWORK, X402Service } from './x402.service';

const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const USDC_SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const PLATFORM = 'GCSVZTXFDMV2UIO2PPQ4A5E2FX7N5ABB2WWT6VJUPGVEKIALP6ZHDPQ4';
const PAYER = 'GBRZSG7K6ZXJRCMYM2O2HO2DKR7RO2ACZ5FARBMQZBB4YZMDFDXFUTV7';
const TX = 'e05aaeecfa111be82332f346eed8a61bf24610dea9b2ed97ed829e5ea14535bc';
const URL = 'http://localhost:3000/api/pay/L7QRCE4U/agent';

const transfer = (amount = '0.1000000') => ({
  type: 'invoke_host_function',
  transaction_hash: TX,
  created_at: new Date().toISOString(),
  asset_balance_changes: [
    {
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: ISSUER,
      type: 'transfer',
      from: PAYER,
      to: PLATFORM,
      amount,
    },
  ],
});

function setup(linkStatus = 'open') {
  const link = {
    id: 'link-1',
    code: 'L7QRCE4U',
    merchantId: 'm-1',
    title: 'x402 spike link',
    status: linkStatus,
    amountTRY: new Decimal('3.40'),
    quotedUSDC: new Decimal('0.1'),
    receivedUSDC: new Decimal(0),
  };
  const facilitator = {
    getSupported: jest.fn().mockResolvedValue({
      kinds: [
        {
          x402Version: 2,
          scheme: 'exact',
          network: X402_NETWORK,
          extra: { areFeesSponsored: true },
        },
      ],
      extensions: [],
      signers: {},
    }),
    verify: jest.fn().mockResolvedValue({ isValid: true, payer: PAYER }),
    settle: jest.fn().mockResolvedValue({
      success: true,
      transaction: TX,
      network: X402_NETWORK,
      payer: PAYER,
    }),
  } satisfies FacilitatorClient;

  const prisma = {
    paymentLink: { findUniqueOrThrow: jest.fn().mockResolvedValue(link) },
    payment: { findUnique: jest.fn().mockResolvedValue(null) },
    x402Settlement: {
      create: jest.fn().mockResolvedValue({ id: 'xs-1' }),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  // What the reconcile job's scan of the platform account's payments returns.
  const scan = { records: [] as unknown[] };
  const horizon = {
    transactions: () => ({
      transaction: () => ({
        call: jest.fn().mockResolvedValue({ successful: true, ledger_attr: 7 }),
      }),
    }),
    operations: () => ({
      forTransaction: () => ({
        call: jest.fn().mockResolvedValue({ records: [transfer()] }),
      }),
    }),
    payments: () => {
      const chain = {
        forAccount: () => chain,
        order: () => chain,
        limit: () => chain,
        call: () => Promise.resolve({ records: scan.records }),
      };
      return chain;
    },
  };
  const stellar = {
    platformPublicKey: PLATFORM,
    usdcAsset: new Asset('USDC', ISSUER),
    server: horizon,
  };
  const payments = {
    markProcessed: jest.fn().mockResolvedValue(false),
    recordMatch: jest.fn().mockResolvedValue(undefined),
  };
  const payService = { getQuote: jest.fn().mockResolvedValue({}) };
  const env: Record<string, string> = {
    X402_FACILITATOR_URL: 'https://x402.org/facilitator',
    NETWORK_PASSPHRASE: Networks.TESTNET,
    USDC_CODE: 'USDC',
    USDC_ISSUER: ISSUER,
  };
  const config = { get: (k: string) => env[k] } as unknown as ConfigService;

  const service = new X402Service(
    prisma as unknown as PrismaService,
    stellar as unknown as StellarService,
    payments as unknown as PaymentsService,
    payService as unknown as PayService,
    config,
    facilitator,
  );
  return { service, facilitator, prisma, payments, scan };
}

/** A payment header for the requirements the service advertises (the facilitator is faked). */
async function paymentHeader(service: X402Service) {
  const res = await service.handle('L7QRCE4U', undefined, URL);
  const accepted = (res.body as PaymentRequired).accepts[0];
  return encodePaymentSignatureHeader({
    x402Version: 2,
    accepted,
    payload: { transaction: 'AAAA' },
  });
}

describe('X402Service', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('402: advertises the amount due as USDC SAC base units to the platform account', async () => {
    const { service } = setup();
    const res = await service.handle('L7QRCE4U', undefined, URL);

    expect(res.status).toBe(402);
    const body = res.body as PaymentRequired;
    expect(body.x402Version).toBe(2);
    expect(body.resource).toEqual({
      url: URL,
      description: 'LiraLink L7QRCE4U: x402 spike link (3.40 TRY)',
      mimeType: 'application/json',
    });
    expect(body.accepts).toEqual<PaymentRequirements[]>([
      {
        scheme: 'exact',
        network: X402_NETWORK,
        amount: '1000000',
        asset: USDC_SAC,
        payTo: PLATFORM,
        maxTimeoutSeconds: 60,
        extra: { areFeesSponsored: true },
      },
    ]);
    expect(
      decodePaymentRequiredHeader(res.headers['PAYMENT-REQUIRED']),
    ).toEqual(body);
  });

  it('402 invalid_payment_header for an undecodable header — nothing verified or settled', async () => {
    const { service, facilitator } = setup();
    const res = await service.handle('L7QRCE4U', 'not-base64!!', URL);

    expect(res.status).toBe(402);
    expect((res.body as PaymentRequired).error).toBe('invalid_payment_header');
    expect(facilitator.verify).not.toHaveBeenCalled();
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it('200: settles, reads the transfer back and credits it on the x402 rail', async () => {
    const { service, payments } = setup();
    const res = await service.handle(
      'L7QRCE4U',
      await paymentHeader(service),
      URL,
    );

    expect(res.status).toBe(200);
    expect(payments.markProcessed).toHaveBeenCalledWith(`x402:${TX}`);
    const [, op, code, result, ledger, rail] = payments.recordMatch.mock
      .calls[0] as [
      unknown,
      { txHash: string },
      string,
      { kind: string },
      number,
      string,
    ];
    expect(op.txHash).toBe(TX);
    expect([code, result.kind, ledger, rail]).toEqual([
      'L7QRCE4U',
      'paid',
      7,
      'x402',
    ]);
  });

  it('409 for a replayed tx hash — never credited twice', async () => {
    const { service, payments } = setup();
    const header = await paymentHeader(service);
    payments.markProcessed.mockResolvedValue(true);

    await expect(service.handle('L7QRCE4U', header, URL)).rejects.toThrow(
      ConflictException,
    );
    expect(payments.recordMatch).not.toHaveBeenCalled();
  });

  it('409 for a link that is already paid — no requirements, no settle', async () => {
    const { service, facilitator } = setup('paid');

    await expect(service.handle('L7QRCE4U', undefined, URL)).rejects.toThrow(
      ConflictException,
    );
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  describe('facilitator settle timeout', () => {
    it('202: records a pending x402 settlement instead of failing', async () => {
      const { service, facilitator, prisma, payments } = setup();
      const header = await paymentHeader(service);
      facilitator.settle.mockRejectedValue(
        new FacilitatorTimeoutError('settle', 30_000),
      );

      const res = await service.handle('L7QRCE4U', header, URL);

      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({
        status: 'pending',
        x402SettlementId: 'xs-1',
      });
      const [{ data }] = prisma.x402Settlement.create.mock.calls[0] as [
        { data: { linkCode: string; payer: string; amountUSDC: Decimal } },
      ];
      expect(data.linkCode).toBe('L7QRCE4U');
      expect(data.payer).toBe(PAYER);
      expect(data.amountUSDC.toFixed(7)).toBe('0.1000000');
      expect(payments.recordMatch).not.toHaveBeenCalled();
    });

    function pendingRow(expiresInMs: number) {
      return {
        id: 'xs-1',
        linkCode: 'L7QRCE4U',
        payer: PAYER,
        amountUSDC: new Decimal('0.1'),
        paymentPayload: { x402Version: 2, payload: {} },
        requirements: { amount: '1000000' },
        status: 'pending',
        createdAt: new Date(Date.now() - 30_000),
        expiresAt: new Date(Date.now() + expiresInMs),
      };
    }

    it('reconcile: credits a transfer that landed on-chain after the timeout', async () => {
      const { service, facilitator, prisma, payments, scan } = setup();
      prisma.x402Settlement.findMany.mockResolvedValue([pendingRow(30_000)]);
      scan.records = [transfer()];

      await service.reconcilePending();

      expect(facilitator.settle).not.toHaveBeenCalled();
      expect(payments.recordMatch).toHaveBeenCalled();
      expect(prisma.x402Settlement.update).toHaveBeenCalledWith({
        where: { id: 'xs-1' },
        data: { status: 'settled', txHash: TX },
      });
    });

    it('reconcile: retries the settle while the auth entries are still valid', async () => {
      const { service, facilitator, prisma, payments } = setup();
      prisma.x402Settlement.findMany.mockResolvedValue([pendingRow(30_000)]);

      await service.reconcilePending();

      expect(facilitator.settle).toHaveBeenCalledTimes(1);
      expect(payments.recordMatch).toHaveBeenCalled();
      expect(prisma.x402Settlement.update).toHaveBeenCalledWith({
        where: { id: 'xs-1' },
        data: { status: 'settled', txHash: TX },
      });
    });

    it('reconcile: stays pending when the retry times out again', async () => {
      const { service, facilitator, prisma } = setup();
      prisma.x402Settlement.findMany.mockResolvedValue([pendingRow(30_000)]);
      facilitator.settle.mockRejectedValue(
        new FacilitatorTimeoutError('settle', 30_000),
      );

      await service.reconcilePending();

      const statuses = prisma.x402Settlement.update.mock.calls.map(
        ([arg]: [{ data: { status?: string } }]) => arg.data.status,
      );
      expect(statuses).not.toContain('settled');
      expect(statuses).not.toContain('failed');
    });

    it('reconcile: fails it once the entries expired (plus grace) with nothing on-chain', async () => {
      const { service, facilitator, prisma } = setup();
      prisma.x402Settlement.findMany.mockResolvedValue([
        pendingRow(-3 * 60_000),
      ]);

      await service.reconcilePending();

      expect(facilitator.settle).not.toHaveBeenCalled();
      expect(prisma.x402Settlement.update).toHaveBeenCalledWith({
        where: { id: 'xs-1' },
        data: { status: 'failed', failReason: 'not_settled_before_expiry' },
      });
    });
  });
});
