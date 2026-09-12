import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { setTimeout as sleep } from 'node:timers/promises';
import { Decimal } from '../common/decimal';
import { AnchorAdapter, SettleResult } from './anchor.adapter';

/** Completes every settlement (no fee) and payout after ANCHOR_MOCK_DELAY_MS, with deterministic `mock-…` refs. */
@Injectable()
export class MockAnchorAdapter implements AnchorAdapter {
  readonly name = 'mock' as const;
  private readonly delayMs: number;

  constructor(config: ConfigService) {
    this.delayMs = config.get<number>('ANCHOR_MOCK_DELAY_MS')!;
  }

  async settleToTRY(input: {
    settlement: { id: string };
  }): Promise<SettleResult> {
    await sleep(this.delayMs);
    return {
      status: 'completed',
      ref: `mock-settle-${input.settlement.id}`,
      feeUSDC: new Decimal(0),
    };
  }

  async payoutTRY(input: { withdrawalId: string }): Promise<{ ref: string }> {
    await sleep(this.delayMs);
    return { ref: `mock-payout-${input.withdrawalId}` };
  }
}
