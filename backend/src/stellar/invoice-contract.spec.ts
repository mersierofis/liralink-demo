import { nativeToScVal } from '@stellar/stellar-sdk';
import { Decimal } from '../common/decimal';
import {
  contractErrorCode,
  deadlineLedgerFor,
  parsePaidEvent,
  stroopsToUsdc,
  usdcToStroops,
} from './invoice-contract';

const PLATFORM = 'GDWV6USF4R2ULWR5XW3TEUZSIRGRCU7PQWGSBDYJVIRFNAJ3LVNQ34N2';
const PAYER = 'GBRZSG7K6ZXJRCMYM2O2HO2DKR7RO2ACZ5FARBMQZBB4YZMDFDXFUTV7';

function paidValue(amount: bigint) {
  return nativeToScVal(
    { amount, merchant: PLATFORM, payer: PAYER },
    {
      type: {
        amount: ['symbol', 'i128'],
        merchant: ['symbol', 'address'],
        payer: ['symbol', 'address'],
      },
    },
  );
}

describe('invoice-contract helpers', () => {
  it('converts USDC to stroops and back exactly', () => {
    expect(usdcToStroops(new Decimal('147.0588236'))).toBe(1470588236n);
    expect(stroopsToUsdc(1470588236n).toFixed(7)).toBe('147.0588236');
  });

  it('rejects amounts with more than 7 decimals', () => {
    expect(() => usdcToStroops(new Decimal('1.00000001'))).toThrow();
  });

  it('puts the deadline before expiresAt assuming slow (6 s) ledgers', () => {
    const now = new Date('2026-09-12T00:00:00Z');
    const expiresAt = new Date('2026-09-13T00:00:00Z'); // 86 400 s
    expect(deadlineLedgerFor(expiresAt, now, 1000)).toBe(1000 + 14_400);
    expect(deadlineLedgerFor(now, expiresAt, 1000)).toBe(1000);
  });

  it('decodes a paid event', () => {
    const topic = [
      nativeToScVal('paid', { type: 'symbol' }),
      nativeToScVal('K7Q2M9XA', { type: 'symbol' }),
    ];
    const paid = parsePaidEvent(topic, paidValue(100_000_000n));
    expect(paid).not.toBeNull();
    expect(paid!.code).toBe('K7Q2M9XA');
    expect(paid!.payer).toBe(PAYER);
    expect(paid!.merchant).toBe(PLATFORM);
    expect(paid!.amountUSDC.toFixed(7)).toBe('10.0000000');
  });

  it('ignores other invoice events', () => {
    const topic = [
      nativeToScVal('created', { type: 'symbol' }),
      nativeToScVal('K7Q2M9XA', { type: 'symbol' }),
    ];
    expect(parsePaidEvent(topic, paidValue(1n))).toBeNull();
  });

  it('parses contract error codes from simulation errors', () => {
    expect(contractErrorCode('HostError: Error(Contract, #1)\n...')).toBe(1);
    expect(contractErrorCode('network timeout')).toBeNull();
  });
});
