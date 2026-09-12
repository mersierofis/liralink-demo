import { Decimal } from '../common/decimal';
import {
  InvalidFeeError,
  netSettlementTRY,
  splitSettlement,
} from './settlement-math';

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

describe('netSettlementTRY', () => {
  it('is the gross amountTRY when there is no fee', () => {
    expect(
      netSettlementTRY(
        new Decimal('340.00'),
        new Decimal('10.0000000'),
        new Decimal(0),
      ).toFixed(2),
    ).toBe('340.00');
  });

  it('deducts the fee pro rata (testanchor: 10%)', () => {
    expect(
      netSettlementTRY(
        new Decimal('34.00'),
        new Decimal('1.0000000'),
        new Decimal('0.1'),
      ).toFixed(2),
    ).toBe('30.60');
  });

  it('rounds down to kuruş', () => {
    // 100.01 × 2.6473236 / 2.9414706 = 90.00900003…
    expect(
      netSettlementTRY(
        new Decimal('100.01'),
        new Decimal('2.9414706'),
        new Decimal('0.2941470'),
      ).toFixed(2),
    ).toBe('90.00');
    // 10.00 × 2 / 3 = 6.666…
    expect(
      netSettlementTRY(
        new Decimal('10.00'),
        new Decimal('3'),
        new Decimal('1'),
      ).toFixed(2),
    ).toBe('6.66');
  });

  it('accepts the boundaries: a zero fee and a fee equal to the settled USDC', () => {
    const amountTRY = new Decimal('34.00');
    const amountUSDC = new Decimal('1');
    expect(
      netSettlementTRY(amountTRY, amountUSDC, new Decimal(0)).toFixed(2),
    ).toBe('34.00');
    expect(netSettlementTRY(amountTRY, amountUSDC, amountUSDC).toFixed(2)).toBe(
      '0.00',
    );
  });

  it('throws InvalidFeeError for a fee below zero or above the settled USDC', () => {
    const amountTRY = new Decimal('34.00');
    const amountUSDC = new Decimal('1');
    expect(() =>
      netSettlementTRY(amountTRY, amountUSDC, new Decimal('-0.1')),
    ).toThrow(InvalidFeeError);
    expect(() =>
      netSettlementTRY(amountTRY, amountUSDC, new Decimal('1.0000001')),
    ).toThrow(InvalidFeeError);
  });
});
