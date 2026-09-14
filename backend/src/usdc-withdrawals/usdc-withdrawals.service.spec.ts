import {
  BadRequestException,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Keypair } from '@stellar/stellar-sdk';
import type { BalanceService } from '../balance/balance.service';
import { Decimal } from '../common/decimal';
import type { UsdcWithdrawal } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { StellarService } from '../stellar/stellar.service';
import { UsdcWithdrawalsService } from './usdc-withdrawals.service';

const PLATFORM = Keypair.random().publicKey();
const DESTINATION = Keypair.random().publicKey();

function row(overrides: Partial<UsdcWithdrawal> = {}): UsdcWithdrawal {
  return {
    id: 'w1',
    merchantId: 'm1',
    amountUSDC: new Decimal('1.5000000'),
    destination: DESTINATION,
    source: 'unallocated',
    status: 'submitted',
    txHash: 'ab'.repeat(32),
    txXdr: 'SIGNED-XDR',
    failReason: null,
    createdAt: new Date(),
    completedAt: null,
    ...overrides,
  };
}

function setup(
  balance = { savedUSDC: '0.0000000', unallocatedUSDC: '2.0000000' },
) {
  const calls: string[] = [];
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    merchant: { update: jest.fn().mockResolvedValue({}) },
    usdcWithdrawal: {
      create: jest.fn((args: { data: Partial<UsdcWithdrawal> }) => {
        calls.push('persist');
        return Promise.resolve(row(args.data));
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const prisma = {
    $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    usdcWithdrawal: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue(row()),
    },
  };
  const balanceService = {
    getBalance: jest.fn().mockResolvedValue(balance),
  };
  const signedTx = {
    hash: () => Buffer.from('cd'.repeat(32), 'hex'),
    toXDR: () => 'NEW-XDR',
  };
  const stellar = {
    platformPublicKey: PLATFORM,
    usdcDestinationProblem: jest.fn().mockResolvedValue(null),
    buildUsdcPayment: jest.fn(() => {
      calls.push('sign');
      return Promise.resolve(signedTx);
    }),
    transactionFromXdr: jest.fn((xdr: string) => ({ xdr })),
    findTransaction: jest.fn().mockResolvedValue(null),
    expired: jest.fn().mockResolvedValue(false),
    submitSigned: jest.fn(() => {
      calls.push('submit');
      return Promise.resolve();
    }),
  };
  const service = new UsdcWithdrawalsService(
    prisma as unknown as PrismaService,
    balanceService as unknown as BalanceService,
    stellar as unknown as StellarService,
  );
  return { service, prisma, tx, stellar, calls };
}

describe('UsdcWithdrawalsService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('resolve — signed-then-submit', () => {
    it('completes a transaction that already landed, without resubmitting it', async () => {
      const { service, prisma, stellar } = setup();
      stellar.findTransaction.mockResolvedValue({ successful: true });
      await service.resolve(row());

      expect(stellar.submitSigned).not.toHaveBeenCalled();
      expect(prisma.usdcWithdrawal.updateMany).toHaveBeenCalledWith({
        where: { id: 'w1', status: 'submitted' },
        data: { status: 'completed', completedAt: expect.any(Date) as unknown },
      });
    });

    it('resubmits the stored XDR — never a newly signed transaction', async () => {
      const { service, stellar } = setup();
      await service.resolve(row());

      expect(stellar.buildUsdcPayment).not.toHaveBeenCalled();
      expect(stellar.transactionFromXdr).toHaveBeenCalledWith('SIGNED-XDR');
      expect(stellar.submitSigned).toHaveBeenCalledWith({ xdr: 'SIGNED-XDR' });
    });

    it('fails a transaction that landed unsuccessfully and releases unallocatedUSDC', async () => {
      const { service, tx, stellar } = setup();
      stellar.findTransaction.mockResolvedValue({ successful: false });
      await service.resolve(row());

      expect(tx.usdcWithdrawal.updateMany).toHaveBeenCalledWith({
        where: { id: 'w1', status: 'submitted' },
        data: { status: 'failed', failReason: 'failed_on_ledger' },
      });
      expect(tx.merchant.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: { unallocatedUSDC: { increment: new Decimal('1.5000000') } },
      });
    });

    it('fails an expired, never-landed transaction; a saved-source row needs no counter release', async () => {
      const { service, tx, stellar } = setup();
      stellar.expired.mockResolvedValue(true);
      await service.resolve(row({ source: 'saved' }));

      expect(stellar.submitSigned).not.toHaveBeenCalled();
      expect(tx.usdcWithdrawal.updateMany).toHaveBeenCalledWith({
        where: { id: 'w1', status: 'submitted' },
        data: { status: 'failed', failReason: 'expired_unsubmitted' },
      });
      expect(tx.merchant.update).not.toHaveBeenCalled();
    });

    it('leaves the row submitted when the submit errors and nothing is on the ledger', async () => {
      const { service, prisma, stellar } = setup();
      stellar.submitSigned.mockRejectedValue(new Error('timeout'));
      const result = await service.resolve(row());

      expect(result.status).toBe('submitted');
      expect(prisma.usdcWithdrawal.updateMany).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('marks failed_on_ledger when the submit errors because the transaction failed on-ledger', async () => {
      const { service, tx, stellar } = setup();
      stellar.findTransaction
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ successful: false });
      stellar.submitSigned.mockRejectedValue(new Error('tx_failed'));
      await service.resolve(row());

      expect(tx.usdcWithdrawal.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: 'failed', failReason: 'failed_on_ledger' },
        }),
      );
    });

    it('releases the debit only once when a row was already failed by another run', async () => {
      const { service, tx, stellar } = setup();
      stellar.expired.mockResolvedValue(true);
      tx.usdcWithdrawal.updateMany.mockResolvedValue({ count: 0 });
      await service.resolve(row());

      expect(tx.merchant.update).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    const dto = (over: Record<string, string> = {}) =>
      ({
        amountUSDC: '1.0000000',
        destination: DESTINATION,
        source: 'unallocated',
        ...over,
      }) as never;

    it('rejects an address with a bad checksum (400) before touching Horizon', async () => {
      const { service, stellar } = setup();
      await expect(
        service.create('m1', dto({ destination: `G${'A'.repeat(55)}` })),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(stellar.usdcDestinationProblem).not.toHaveBeenCalled();
    });

    it('rejects a zero amount (400)', async () => {
      const { service } = setup();
      await expect(
        service.create('m1', dto({ amountUSDC: '0.0000000' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('422s with the plain Horizon message when the destination has no USDC trustline', async () => {
      const { service, prisma, stellar } = setup();
      stellar.usdcDestinationProblem.mockResolvedValue(
        `Destination ${DESTINATION} has no USDC trustline`,
      );
      await expect(service.create('m1', dto())).rejects.toThrow(
        new UnprocessableEntityException(
          `Destination ${DESTINATION} has no USDC trustline`,
        ),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('422s for the platform account as destination', async () => {
      const { service } = setup();
      await expect(
        service.create('m1', dto({ destination: PLATFORM })),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('422s when the amount exceeds the source balance — nothing signed, debited or sent', async () => {
      const { service, tx, stellar } = setup({
        savedUSDC: '0.5000000',
        unallocatedUSDC: '9.0000000',
      });
      await expect(
        service.create('m1', dto({ source: 'saved' })),
      ).rejects.toThrow('amountUSDC 1.0000000 exceeds savedUSDC 0.5000000');
      expect(stellar.buildUsdcPayment).not.toHaveBeenCalled();
      expect(tx.merchant.update).not.toHaveBeenCalled();
      expect(stellar.submitSigned).not.toHaveBeenCalled();
    });

    it('locks, debits unallocatedUSDC and persists the signed tx before submitting it', async () => {
      const { service, tx, stellar, calls } = setup();
      await service.create('m1', dto());

      expect(tx.$queryRaw).toHaveBeenCalled();
      expect(tx.merchant.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: { unallocatedUSDC: { decrement: new Decimal('1.0000000') } },
      });
      expect(tx.usdcWithdrawal.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          txHash: 'cd'.repeat(32),
          txXdr: 'NEW-XDR',
          source: 'unallocated',
        }) as unknown,
      });
      expect(calls).toEqual(['sign', 'persist', 'submit']);
      expect(stellar.transactionFromXdr).toHaveBeenCalledWith('NEW-XDR');
    });

    it('does not decrement the stored counter for a saved-source withdrawal', async () => {
      const { service, tx } = setup({
        savedUSDC: '3.0000000',
        unallocatedUSDC: '0.0000000',
      });
      await service.create('m1', dto({ source: 'saved' }));
      expect(tx.merchant.update).not.toHaveBeenCalled();
    });
  });
});
