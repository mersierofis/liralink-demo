import { Decimal } from '../common/decimal';
import {
  decodeMemoCode,
  InboundOp,
  LinkForMatch,
  match,
  MatchConfig,
} from './matcher';

const PLATFORM = 'GDC2I5BUJ5KVYUZGZCXCE3S5SPWB7WW722SGENCBYJ7VYFGPYT4Z7OSE';
const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const cfg: MatchConfig = {
  platformAddress: PLATFORM,
  assetCode: 'USDC',
  assetIssuer: ISSUER,
};

function baseOp(overrides: Partial<InboundOp> = {}): InboundOp {
  return {
    opId: '19867887351111681',
    txHash: '0334cd305019c8a73db6562d1c5f6351f4eead1220b100383b7d022683619d5d',
    from: 'GAVQ7574Q3PNOZNIMDODRZHR7A64VHPCR5TQL2R7VQEWJFMTPQFY5CNM',
    to: PLATFORM,
    assetType: 'credit_alphanum4',
    assetCode: 'USDC',
    assetIssuer: ISSUER,
    amount: '10.0000000',
    memoType: 'text',
    memoBytes: Buffer.from('K7Q2M9XA', 'utf8').toString('base64'),
    successful: true,
    ...overrides,
  };
}

const openLink: LinkForMatch = {
  code: 'K7Q2M9XA',
  status: 'open',
  quotedUSDC: new Decimal('10.0000000'),
  receivedUSDC: new Decimal('0'),
};

describe('decodeMemoCode', () => {
  it('decodes base64 back to the uppercase code, trimmed', () => {
    expect(
      decodeMemoCode(Buffer.from('k7q2m9xa ', 'utf8').toString('base64')),
    ).toBe('K7Q2M9XA');
  });
});

describe('match', () => {
  it('matches an exact payment as paid with no excess', () => {
    expect(match(baseOp(), openLink, cfg)).toEqual({
      kind: 'paid',
      amountUSDC: new Decimal('10.0000000'),
      totalReceivedUSDC: new Decimal('10.0000000'),
      excessUSDC: new Decimal('0'),
    });
  });

  it('matches an overpayment as paid and reports the excess', () => {
    const result = match(baseOp({ amount: '15.0000000' }), openLink, cfg);
    expect(result).toEqual({
      kind: 'paid',
      amountUSDC: new Decimal('15.0000000'),
      totalReceivedUSDC: new Decimal('15.0000000'),
      excessUSDC: new Decimal('5.0000000'),
    });
  });

  it('flags an underpayment without marking the link paid, reporting the shortfall', () => {
    const result = match(baseOp({ amount: '9.9999999' }), openLink, cfg);
    expect(result).toEqual({
      kind: 'underpaid',
      amountUSDC: new Decimal('9.9999999'),
      totalReceivedUSDC: new Decimal('9.9999999'),
      shortfallUSDC: new Decimal('0.0000001'),
    });
  });

  it('accepts a top-up payment on an already-underpaid link and reaches paid', () => {
    const partiallyPaidLink: LinkForMatch = {
      ...openLink,
      status: 'underpaid',
      receivedUSDC: new Decimal('6.0000000'),
    };
    const result = match(
      baseOp({ amount: '4.0000000' }),
      partiallyPaidLink,
      cfg,
    );
    expect(result).toEqual({
      kind: 'paid',
      amountUSDC: new Decimal('4.0000000'),
      totalReceivedUSDC: new Decimal('10.0000000'),
      excessUSDC: new Decimal('0'),
    });
  });

  it('keeps an underpaid link underpaid on a second partial top-up', () => {
    const partiallyPaidLink: LinkForMatch = {
      ...openLink,
      status: 'underpaid',
      receivedUSDC: new Decimal('6.0000000'),
    };
    const result = match(
      baseOp({ amount: '2.0000000' }),
      partiallyPaidLink,
      cfg,
    );
    expect(result).toEqual({
      kind: 'underpaid',
      amountUSDC: new Decimal('2.0000000'),
      totalReceivedUSDC: new Decimal('8.0000000'),
      shortfallUSDC: new Decimal('2.0000000'),
    });
  });

  it('ignores a failed transaction', () => {
    expect(match(baseOp({ successful: false }), openLink, cfg).kind).toBe(
      'ignored',
    );
  });

  it('ignores a payment to the wrong destination', () => {
    const result = match(baseOp({ to: 'GSOMEOTHERACCOUNT' }), openLink, cfg);
    expect(result).toEqual({ kind: 'ignored', reason: 'wrong destination' });
  });

  it('ignores the wrong asset code', () => {
    const result = match(baseOp({ assetCode: 'FAKEUSDC' }), openLink, cfg);
    expect(result).toEqual({ kind: 'ignored', reason: 'wrong asset' });
  });

  it('ignores a correctly-coded asset from the wrong issuer (anyone can issue "USDC")', () => {
    const result = match(
      baseOp({ assetIssuer: 'GSOMERANDOMISSUER' }),
      openLink,
      cfg,
    );
    expect(result).toEqual({ kind: 'ignored', reason: 'wrong asset' });
  });

  it('ignores a native XLM payment (no asset_code/issuer)', () => {
    const result = match(
      baseOp({
        assetType: 'native',
        assetCode: undefined,
        assetIssuer: undefined,
      }),
      openLink,
      cfg,
    );
    expect(result).toEqual({ kind: 'ignored', reason: 'wrong asset' });
  });

  it('ignores a missing memo', () => {
    const result = match(
      baseOp({ memoType: 'none', memoBytes: undefined }),
      openLink,
      cfg,
    );
    expect(result).toEqual({
      kind: 'ignored',
      reason: 'missing or non-text memo',
    });
  });

  it('ignores a non-text memo type (id/hash/return)', () => {
    const result = match(baseOp({ memoType: 'hash' }), openLink, cfg);
    expect(result).toEqual({
      kind: 'ignored',
      reason: 'missing or non-text memo',
    });
  });

  it('ignores a memo matching no link at all', () => {
    const result = match(baseOp(), null, cfg);
    expect(result).toEqual({
      kind: 'ignored',
      reason: 'no matching link for memo',
    });
  });

  it('treats a payment to an already-paid link as stray (recorded + credited to unallocatedUSDC)', () => {
    const result = match(baseOp(), { ...openLink, status: 'paid' }, cfg);
    expect(result).toEqual({
      kind: 'stray',
      amountUSDC: new Decimal('10.0000000'),
      reason: 'link status is "paid"',
    });
  });

  it('treats a payment to an expired link as stray, carrying this op amount', () => {
    const result = match(
      baseOp({ amount: '3.0000000' }),
      { ...openLink, status: 'expired' },
      cfg,
    );
    expect(result).toEqual({
      kind: 'stray',
      amountUSDC: new Decimal('3.0000000'),
      reason: 'link status is "expired"',
    });
  });

  it('treats a payment to a cancelled link as stray', () => {
    const result = match(baseOp(), { ...openLink, status: 'cancelled' }, cfg);
    expect(result.kind).toBe('stray');
    if (result.kind === 'stray') {
      expect(result.reason).toBe('link status is "cancelled"');
    }
  });

  it('does NOT treat a memo matching no link as stray — that stays ignored', () => {
    // stray only applies when the memo resolves to a real link; an unknown memo is ignored.
    expect(match(baseOp(), null, cfg)).toEqual({
      kind: 'ignored',
      reason: 'no matching link for memo',
    });
  });
});
