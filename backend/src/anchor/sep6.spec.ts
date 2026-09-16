import { Decimal } from '../common/decimal';
import { sep6Payout, sep6Phase } from './sep6';
import { TransferTransaction, withdrawMemo } from './transfer';

const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const OUR_USDC = `stellar:USDC:${ISSUER}`;
const TRY = 'iso4217:TRY';

const txn = (over: Partial<TransferTransaction> = {}): TransferTransaction => ({
  id: 'sep_am7c6x92na0mgr3v5k2r',
  status: 'completed',
  ...over,
});

describe('sep6Phase', () => {
  it.each([
    ['pending_user_transfer_start', 'send_funds'],
    ['pending_anchor', 'in_progress'],
    ['pending_external', 'in_progress'],
    ['pending_customer_info_update', 'in_progress'],
    ['completed', 'completed'],
    ['error', 'failed'],
    ['expired', 'failed'],
    ['too_small', 'failed'],
  ])('maps %s to %s', (status, phase) => {
    expect(sep6Phase(status)).toBe(phase);
  });

  it('treats `incomplete` as a pending anchor state — SEP-6 has no interactive page to send anyone to', () => {
    expect(sep6Phase('incomplete')).toBe('in_progress');
  });
});

describe('sep6Payout', () => {
  it('takes netTRY from amount_out — what the anchor actually paid out', () => {
    const result = sep6Payout(
      txn({
        amount_in: '1.0328382',
        amount_in_asset: OUR_USDC,
        amount_out: '50.00',
        amount_out_asset: TRY,
        amount_fee: '0.25',
        amount_fee_asset: TRY,
      }),
      OUR_USDC,
      TRY,
    );
    // The 0.25 TRY fee is already deducted from amount_out; counting it again would net it twice.
    expect(result).toEqual({
      ok: true,
      feeUSDC: new Decimal(0),
      netTRY: new Decimal('50.00'),
    });
  });

  it('reports a fee the anchor denominates in our USDC, alongside the TRY paid out', () => {
    const result = sep6Payout(
      txn({
        amount_out: '48.17',
        amount_out_asset: TRY,
        fee_details: { total: '0.0050838', asset: OUR_USDC },
      }),
      OUR_USDC,
      TRY,
    );
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.feeUSDC.toFixed(7)).toBe('0.0050838');
    expect(result.ok && result.netTRY?.toFixed(2)).toBe('48.17');
  });

  it('falls back to fee-derived netTRY when the anchor reports no TRY amount_out', () => {
    const result = sep6Payout(
      txn({ fee_details: { total: '0.1', asset: OUR_USDC } }),
      OUR_USDC,
      TRY,
    );
    // netTRY null → SettlementsService derives it from feeUSDC as it always has.
    expect(result).toEqual({
      ok: true,
      feeUSDC: new Decimal('0.1'),
      netTRY: null,
    });
  });

  it('ignores an amount_out denominated in something other than TRY', () => {
    const result = sep6Payout(
      txn({
        amount_out: '48.17',
        amount_out_asset: 'iso4217:USD',
        fee_details: { total: '0', asset: OUR_USDC },
      }),
      OUR_USDC,
      TRY,
    );
    expect(result).toMatchObject({ ok: true, netTRY: null });
  });

  it('fails when the fee is in a third asset and there is no TRY amount_out to fall back on', () => {
    const result = sep6Payout(
      txn({ fee_details: { total: '0.1', asset: 'iso4217:USD' } }),
      OUR_USDC,
      TRY,
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.detail).toContain('iso4217:USD');
  });

  it('refuses a negative amount_out', () => {
    const result = sep6Payout(
      txn({ amount_out: '-1.00', amount_out_asset: TRY }),
      OUR_USDC,
      TRY,
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.detail).toContain('negative');
  });
});

describe('the withdraw memo', () => {
  it('attaches the anchor memo as MEMO_ID, never text — SEP-6 anchors match on an id memo', () => {
    const memo = withdrawMemo('id', '869671972907');
    expect(memo.type).toBe('id');
    expect(memo.value).toBe('869671972907');
  });
});
