import { Logger } from '@nestjs/common';
import type { AnchorAdapter, SettleResult } from '../anchor/anchor.adapter';
import { Decimal } from '../common/decimal';
import type { Merchant, Settlement } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { SettlementsService } from './settlements.service';

const SETTLEMENT = {
  id: 's1',
  provider: 'sep24',
  status: 'processing',
  blockedReason: null,
  amountTRY: new Decimal('34.00'),
  amountUSDC: new Decimal('1.0000000'),
} as unknown as Settlement;

function serviceSettlingWith(result: SettleResult) {
  const update = jest.fn().mockResolvedValue({});
  const prisma = { settlement: { update } } as unknown as PrismaService;
  const adapter: AnchorAdapter = {
    name: 'sep24',
    settleToTRY: jest.fn().mockResolvedValue(result),
    payoutTRY: jest.fn(),
  };
  const service = new SettlementsService(prisma, adapter, { sep24: adapter });
  // run() is private — the payment.detected handler and the reconcile job are its callers.
  const run = () =>
    (
      service as unknown as {
        run(s: Settlement, m: Merchant): Promise<void>;
      }
    ).run(SETTLEMENT, {} as Merchant);
  return { run, update };
}

const statusesWritten = (update: jest.Mock) =>
  update.mock.calls.map(
    ([arg]: [{ data: { status?: string } }]) => arg.data.status,
  );

describe('SettlementsService — terminal settlement failures', () => {
  let errorLog: jest.SpyInstance;
  beforeEach(() => {
    errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['above amountUSDC', '1.5'],
    ['below zero', '-0.1'],
  ])(
    'fails with invalid_fee when the anchor fee is %s — no completion, logged at ERROR',
    async (_label, fee) => {
      const { run, update } = serviceSettlingWith({
        status: 'completed',
        ref: 'anchor-1',
        feeUSDC: new Decimal(fee),
      });
      await run();

      expect(update).toHaveBeenLastCalledWith({
        where: { id: 's1' },
        data: expect.objectContaining({
          status: 'failed',
          failReason: 'invalid_fee',
          anchorRef: 'anchor-1',
        }) as unknown,
      });
      expect(statusesWritten(update)).not.toContain('completed');
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('failed (invalid_fee)'),
      );
    },
  );

  it('stores the adapter failReason (unexpected_fee_asset) and logs at ERROR', async () => {
    const { run, update } = serviceSettlingWith({
      status: 'failed',
      ref: 'anchor-1',
      reason: 'unexpected_fee_asset',
      detail: 'fee in iso4217:USD',
    });
    await run();

    expect(update).toHaveBeenLastCalledWith({
      where: { id: 's1' },
      data: {
        status: 'failed',
        anchorRef: 'anchor-1',
        failReason: 'unexpected_fee_asset',
      },
    });
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('unexpected_fee_asset'),
    );
  });

  it('still completes a valid fee with netTRY', async () => {
    const { run, update } = serviceSettlingWith({
      status: 'completed',
      ref: 'anchor-1',
      feeUSDC: new Decimal('0.1'),
    });
    await run();

    const last = update.mock.lastCall as [
      { data: { status: string; netTRY: Decimal; failReason?: string } },
    ];
    expect(last[0].data.status).toBe('completed');
    expect(last[0].data.netTRY.toFixed(2)).toBe('30.60');
    expect(last[0].data.failReason).toBeUndefined();
  });
});
