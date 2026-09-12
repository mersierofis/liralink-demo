import { Decimal } from '../common/decimal';
import { jwtExpiresAt, sep24Phase, withdrawBlock, withdrawMemo } from './sep24';

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
