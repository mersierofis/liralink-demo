import { Decimal } from '../common/decimal';
import {
  jwtExpiresAt,
  sep24FeeUSDC,
  sep24Phase,
  withdrawBlock,
  withdrawMemo,
} from './sep24';

const USDC =
  'stellar:USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

describe('sep24FeeUSDC', () => {
  const base = { id: 'x', status: 'completed' };

  it('reads fee_details in our USDC (testanchor: 10%)', () => {
    expect(
      sep24FeeUSDC(
        { ...base, fee_details: { total: '0.1', asset: USDC } },
        USDC,
      )?.toFixed(7),
    ).toBe('0.1000000');
  });

  it('falls back to amount_fee, in the asset sent when no fee asset is given', () => {
    expect(
      sep24FeeUSDC(
        { ...base, amount_fee: '0.25', amount_in_asset: USDC },
        USDC,
      )?.toFixed(7),
    ).toBe('0.2500000');
  });

  it('is zero when the anchor reports no fee', () => {
    expect(sep24FeeUSDC(base, USDC)?.toFixed(7)).toBe('0.0000000');
  });

  it('is null for a fee in another asset', () => {
    expect(
      sep24FeeUSDC(
        { ...base, fee_details: { total: '0.1', asset: 'iso4217:USD' } },
        USDC,
      ),
    ).toBeNull();
  });
});

const INFO = {
  withdraw: { USDC: { enabled: true, min_amount: 1, max_amount: 10 } },
};

describe('sep24 helpers', () => {
  it('maps SEP-24 statuses to what we do next', () => {
    expect(sep24Phase('incomplete')).toBe('interactive');
    expect(sep24Phase('pending_user_transfer_start')).toBe('send_funds');
    expect(sep24Phase('pending_anchor')).toBe('in_progress');
    expect(sep24Phase('pending_external')).toBe('in_progress');
    expect(sep24Phase('completed')).toBe('completed');
    expect(sep24Phase('refunded')).toBe('failed');
    expect(sep24Phase('expired')).toBe('failed');
  });

  it('blocks withdraws outside the anchor limits or when disabled', () => {
    expect(withdrawBlock(INFO, 'USDC', new Decimal('1'))).toBeNull();
    expect(withdrawBlock(INFO, 'USDC', new Decimal('10'))).toBeNull();
    expect(withdrawBlock(INFO, 'USDC', new Decimal('0.9999999'))?.reason).toBe(
      'outside_anchor_limits',
    );
    expect(withdrawBlock(INFO, 'USDC', new Decimal('10.0000001'))?.reason).toBe(
      'outside_anchor_limits',
    );
    expect(withdrawBlock(INFO, 'SRT', new Decimal('5'))?.reason).toBe(
      'anchor_withdraw_disabled',
    );
    expect(
      withdrawBlock(
        { withdraw: { USDC: { enabled: false } } },
        'USDC',
        new Decimal('5'),
      )?.reason,
    ).toBe('anchor_withdraw_disabled');
  });

  it('builds the memo the anchor asked for', () => {
    expect(withdrawMemo('id', '255806071554928210').value).toBe(
      '255806071554928210',
    );
    expect(withdrawMemo('text', 'abc').type).toBe('text');
    const hash = Buffer.alloc(32, 7);
    expect(
      Buffer.from(
        withdrawMemo('hash', hash.toString('base64')).value as Buffer,
      ),
    ).toEqual(hash);
    expect(withdrawMemo(undefined, undefined).type).toBe('none');
    expect(() => withdrawMemo('weird', 'x')).toThrow();
  });

  it('reads a JWT expiry, defaulting when unreadable', () => {
    const payload = Buffer.from(
      JSON.stringify({ exp: 2_000_000_000 }),
    ).toString('base64url');
    expect(jwtExpiresAt(`h.${payload}.s`)).toBe(2_000_000_000_000);
    expect(jwtExpiresAt('garbage', 1000)).toBe(1000 + 5 * 60_000);
  });
});
