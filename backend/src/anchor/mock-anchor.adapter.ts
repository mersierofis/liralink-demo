import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { setTimeout as sleep } from 'node:timers/promises';
import { SettleStatus } from '../generated/prisma/client';
import { AnchorAdapter } from './anchor.adapter';

/** Completes every settlement and payout after ANCHOR_MOCK_DELAY_MS, with deterministic `mock-…` refs. */
@Injectable()
export class MockAnchorAdapter implements AnchorAdapter {
  readonly name = 'mock' as const;
  private readonly delayMs: number;

  constructor(config: ConfigService) {
    this.delayMs = config.get<number>('ANCHOR_MOCK_DELAY_MS')!;
  }

  async settleToTRY(input: { settlementId: string }): Promise<{ ref: string }> {
    await sleep(this.delayMs);
    return { ref: `mock-settle-${input.settlementId}` };
  }

  async payoutTRY(input: { withdrawalId: string }): Promise<{ ref: string }> {
    await sleep(this.delayMs);
    return { ref: `mock-payout-${input.withdrawalId}` };
  }

  getStatus(): Promise<SettleStatus> {
    return Promise.resolve('completed');
  }
}
