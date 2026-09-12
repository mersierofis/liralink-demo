import { Decimal } from '../common/decimal';
import { splitSettlement } from './settlement-math';

describe('splitSettlement', () => {
  it('credits the full locked amountTRY when auto-save is off', () => {
    const s = splitSettlement(
      new Decimal('340.00'),
      new Decimal('10.0000000'),
      0,
    );
    expect(s.amountTRY.toFixed(2)).toBe('340.00');
    expect(s.amountUSDC.toFixed(7)).toBe('10.0000000');
    expect(s.savedUSDC.toFixed(7)).toBe('0.0000000');
  });

  it('keeps autoSavePercent of the USDC and reduces TRY by the same share', () => {
    const s = splitSettlement(
      new Decimal('340.00'),
      new Decimal('10.0000000'),
      15,
    );
    expect(s.savedUSDC.toFixed(7)).toBe('1.5000000');
    expect(s.amountUSDC.toFixed(7)).toBe('8.5000000');
    expect(s.amountTRY.toFixed(2)).toBe('289.00');
  });

  it('rounds saved USDC down and TRY half-up, and USDC always adds back up', () => {
    const quoted = new Decimal('2.9414706');
    const s = splitSettlement(new Decimal('100.01'), quoted, 15);
    expect(s.savedUSDC.toFixed(7)).toBe('0.4412205'); // 0.44122059
    expect(s.amountTRY.toFixed(2)).toBe('85.01'); // 85.0085
    expect(s.amountUSDC.plus(s.savedUSDC).equals(quoted)).toBe(true);
  });
});
