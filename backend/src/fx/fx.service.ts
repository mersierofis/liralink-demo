import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Decimal } from '../common/decimal';

export type FxSource = 'mock' | 'live';

export interface FxRate {
  rate: Decimal;
  source: FxSource;
  fetchedAt: Date;
}

const LIVE_CACHE_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class FxService {
  private readonly logger = new Logger(FxService.name);
  private liveCache: FxRate | null = null;

  constructor(private readonly config: ConfigService) {}

  async getRate(): Promise<FxRate> {
    const provider = this.config.get<string>('FX_PROVIDER');
    if (provider === 'live') {
      const live = await this.getLiveRate();
      if (live) return live;
      this.logger.warn(
        'FX_PROVIDER=live failed to produce a rate; falling back to mock rate',
      );
    }
    return this.getMockRate();
  }

  /** amountTRY / rate, rounded UP to 7 dp so the payer never underpays due to rounding. */
  quote(amountTRY: Decimal, rate: Decimal): Decimal {
    return amountTRY.dividedBy(rate).toDecimalPlaces(7, Decimal.ROUND_UP);
  }

  private getMockRate(): FxRate {
    const rate = new Decimal(
      this.config.get<number>('FX_MOCK_RATE_TRY_PER_USDC')!,
    );
    return { rate, source: 'mock', fetchedAt: new Date() };
  }

  private async getLiveRate(): Promise<FxRate | null> {
    if (
      this.liveCache &&
      Date.now() - this.liveCache.fetchedAt.getTime() < LIVE_CACHE_TTL_MS
    ) {
      return this.liveCache;
    }

    const url = this.config.get<string>('FX_LIVE_URL');
    if (!url) return null;

    try {
      const response = await fetch(url);
      if (!response.ok)
        throw new Error(`FX_LIVE_URL responded ${response.status}`);
      const body: unknown = await response.json();
      const rateValue = (body as { rate?: unknown }).rate;
      if (typeof rateValue !== 'number' && typeof rateValue !== 'string') {
        throw new Error('FX_LIVE_URL response missing numeric "rate" field');
      }
      const fxRate: FxRate = {
        rate: new Decimal(rateValue),
        source: 'live',
        fetchedAt: new Date(),
      };
      this.liveCache = fxRate;
      return fxRate;
    } catch (err) {
      this.logger.error(
        'Failed to fetch live FX rate',
        err instanceof Error ? err.stack : String(err),
      );
      return null;
    }
  }
}
