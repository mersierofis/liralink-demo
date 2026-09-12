import { ConfigService } from '@nestjs/config';
import { Decimal } from '../common/decimal';
import { FxService } from './fx.service';

describe('FxService.quote', () => {
  const service = new FxService({
    get: () => undefined,
  } as unknown as ConfigService);

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
