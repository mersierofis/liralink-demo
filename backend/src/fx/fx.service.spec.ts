import { ConfigService } from '@nestjs/config';
import { AnchorSession } from '../anchor/anchor-session';
import { Decimal } from '../common/decimal';
import { FxService, anchorRateTRYperUSDC } from './fx.service';

describe('FxService.quote', () => {
  const service = new FxService(
    { get: () => undefined } as unknown as ConfigService,
    {} as AnchorSession,
  );

  it('divides exactly when the rate divides cleanly', () => {
    const quoted = service.quote(new Decimal('340.00'), new Decimal('34.00'));
    expect(quoted.toFixed(7)).toBe('10.0000000');
  });

  it('rounds UP on a repeating decimal so the payer never underpays', () => {
    // 100 / 3 = 33.3333... — rounding down would let the payer send less than owed.
    const quoted = service.quote(new Decimal('100'), new Decimal('3'));
    expect(quoted.toFixed(7)).toBe('33.3333334');
  });

  it('rounds UP even on a tiny remainder', () => {
    const quoted = service.quote(new Decimal('1'), new Decimal('3'));
    expect(quoted.toFixed(7)).toBe('0.3333334');
  });

  it('produces exactly 7 decimal places', () => {
    const quoted = service.quote(new Decimal('5000.00'), new Decimal('34.00'));
    expect(quoted.decimalPlaces()).toBeLessThanOrEqual(7);
    expect(quoted.toFixed(7)).toBe('147.0588236');
  });
});

describe('anchorRateTRYperUSDC — the SEP-38 price a link locks', () => {
  it('inverts total_price, which includes the anchor spread', () => {
    // A real tr-mock-anchor answer: sell 1 USDC → buy 48.41 TRY.
    const rate = anchorRateTRYperUSDC({
      total_price: '0.0206568891',
      price: '0.0205518741',
      sell_amount: '1.0000000',
      buy_amount: '48.41',
    });
    expect(rate.toFixed(6)).toBe('48.409999');
  });

  it('prefers total_price over the spread-free price — the settlement pays the spread', () => {
    const withSpread = anchorRateTRYperUSDC({
      total_price: '0.0206568891',
      price: '0.0205518741',
    });
    const withoutSpread = anchorRateTRYperUSDC({ price: '0.0205518741' });
    expect(withSpread.lessThan(withoutSpread)).toBe(true);
  });

  it('rounds down, so the USDC quoted for a link is never short', () => {
    // 1 / 0.003 = 333.333... — a higher rate would quote too little USDC.
    expect(anchorRateTRYperUSDC({ total_price: '0.003' }).toFixed(6)).toBe(
      '333.333333',
    );
  });

  it('falls back to buy_amount / sell_amount when no price is quoted', () => {
    const rate = anchorRateTRYperUSDC({
      sell_amount: '2.0000000',
      buy_amount: '96.82',
    });
    expect(rate.toFixed(6)).toBe('48.410000');
  });

  it.each([
    ['nothing usable', {}],
    ['a zero price', { total_price: '0' }],
    ['a negative price', { total_price: '-0.02' }],
  ])('throws on %s rather than quoting a nonsense rate', (_label, body) => {
    expect(() => anchorRateTRYperUSDC(body)).toThrow('no usable price');
  });
});
