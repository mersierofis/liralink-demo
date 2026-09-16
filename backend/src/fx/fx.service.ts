import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AnchorHttpError, AnchorSession } from '../anchor/anchor-session';
import { Decimal } from '../common/decimal';

export type FxSource = 'mock' | 'live' | 'anchor';

export interface FxRate {
  rate: Decimal;
  source: FxSource;
  fetchedAt: Date;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
/** SEP-38 asset identifier for Turkish lira. */
const TRY_ASSET = 'iso4217:TRY';
/** `fxRate` is `Decimal(20, 7)`; six places is plenty for a TRY/USDC rate. */
const RATE_DP = 6;

/** `GET {ANCHOR_QUOTE_SERVER}/price`, the parts we read. */
export interface Sep38Price {
  total_price?: string;
  price?: string;
  buy_amount?: string;
  sell_amount?: string;
}

/**
 * TRY per USDC from a SEP-38 price quoted as sell USDC → buy TRY.
 *
 * SEP-38 prices are "units of sell_asset per unit of buy_asset", so the reciprocal is the
 * TRY/USDC rate. `total_price` includes the anchor's spread and `price` does not — the spread is
 * what the settlement will really be charged, so `total_price` wins. Rounded **down**, which
 * makes the quoted USDC slightly larger: the payer never sends too little to cover the link.
 */
export function anchorRateTRYperUSDC(body: Sep38Price): Decimal {
  // `greaterThan(0)`, not `isPositive()` — decimal.js counts zero as positive, and 1/0 would
  // sail through as Infinity instead of falling back or throwing.
  const quoted = body.total_price ?? body.price;
  if (quoted !== undefined) {
    const price = new Decimal(quoted);
    if (price.greaterThan(0)) {
      return new Decimal(1)
        .div(price)
        .toDecimalPlaces(RATE_DP, Decimal.ROUND_DOWN);
    }
  }
  if (body.buy_amount !== undefined && body.sell_amount !== undefined) {
    const buy = new Decimal(body.buy_amount);
    const sell = new Decimal(body.sell_amount);
    if (buy.greaterThan(0) && sell.greaterThan(0)) {
      return buy.div(sell).toDecimalPlaces(RATE_DP, Decimal.ROUND_DOWN);
    }
  }
  throw new Error(
    `SEP-38 price response carries no usable price: ${JSON.stringify(body)}`,
  );
}

@Injectable()
export class FxService {
  private readonly logger = new Logger(FxService.name);
  private liveCache: FxRate | null = null;
  private anchorCache: FxRate | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly session: AnchorSession,
  ) {}

  async getRate(): Promise<FxRate> {
    const provider = this.config.get<string>('FX_PROVIDER');
    if (provider === 'anchor') {
      const anchor = await this.getAnchorRate();
      if (anchor) return anchor;
      this.logger.warn(
        'FX_PROVIDER=anchor could not get a SEP-38 price; falling back to the mock rate',
      );
    }
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

  /**
   * The anchor's own SEP-38 rate, so a link is priced at what the settlement will clear at. Cached
   * for five minutes — link creation is on the request path and the rate barely moves.
   */
  private async getAnchorRate(): Promise<FxRate | null> {
    if (fresh(this.anchorCache)) return this.anchorCache;
    try {
      const { quoteServer } = await this.session.endpoints();
      if (!quoteServer) {
        throw new Error(
          `${this.session.homeDomain} stellar.toml has no ANCHOR_QUOTE_SERVER`,
        );
      }
      const query = new URLSearchParams({
        sell_asset: this.usdcAsset(),
        buy_asset: TRY_ASSET,
        sell_amount: '1',
        context: 'sep6',
      });
      const rate = anchorRateTRYperUSDC(
        await this.price(`${quoteServer}/price?${query.toString()}`),
      );
      this.anchorCache = { rate, source: 'anchor', fetchedAt: new Date() };
      this.logger.log(
        `FX rate ${rate.toFixed(2)} TRY/USDC from ${this.session.homeDomain} (SEP-38)`,
      );
      return this.anchorCache;
    } catch (err) {
      this.logger.error(
        'Failed to fetch the anchor SEP-38 rate',
        err instanceof Error ? err.stack : String(err),
      );
      return null;
    }
  }

  /** SEP-38 indicative prices are public; an anchor that still wants the JWT gets it on retry. */
  private async price(url: string): Promise<Sep38Price> {
    try {
      return await this.session.request<Sep38Price>(url);
    } catch (err) {
      if (
        err instanceof AnchorHttpError &&
        (err.status === 401 || err.status === 403)
      ) {
        return this.session.request<Sep38Price>(url, {
          token: await this.session.token(),
        });
      }
      throw err;
    }
  }

  private usdcAsset(): string {
    return `stellar:${this.config.get<string>('USDC_CODE')}:${this.config.get<string>('USDC_ISSUER')}`;
  }

  private async getLiveRate(): Promise<FxRate | null> {
    if (fresh(this.liveCache)) return this.liveCache;

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

function fresh(cached: FxRate | null): cached is FxRate {
  return (
    cached !== null && Date.now() - cached.fetchedAt.getTime() < CACHE_TTL_MS
  );
}
