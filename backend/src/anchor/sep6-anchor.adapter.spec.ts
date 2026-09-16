import { ConfigService } from '@nestjs/config';
import { Keypair } from '@stellar/stellar-sdk';
import { Decimal } from '../common/decimal';
import type { Merchant } from '../generated/prisma/client';
import type { SettleResult, SettlementAnchorState } from './anchor.adapter';
import { AnchorSession } from './anchor-session';
import { Sep6AnchorAdapter } from './sep6-anchor.adapter';
import type { TransferTransaction } from './transfer';

const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const OUR_USDC = `stellar:USDC:${ISSUER}`;
const TRY = 'iso4217:TRY';
const TRANSFER = 'https://anchor.example/sep6';
const IBAN = 'TR330006100519786457841326';

function build(config: Record<string, string> = {}) {
  const settings = new ConfigService({
    ...config,
    ANCHOR_HOME_DOMAIN: 'tr-mock-anchor.fly.dev',
    PLATFORM_ACCOUNT_SECRET: Keypair.random().secret(),
    HORIZON_URL: 'https://horizon-testnet.stellar.org',
    NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
    USDC_CODE: 'USDC',
    USDC_ISSUER: ISSUER,
  });
  const session = new AnchorSession(settings);
  jest.spyOn(session, 'transferServer').mockResolvedValue(TRANSFER);
  jest.spyOn(session, 'token').mockResolvedValue('jwt');
  return { adapter: new Sep6AnchorAdapter(settings, session), session };
}

/** An adapter whose anchor always reports `txn` — no network involved. */
function adapterSeeing(txn: TransferTransaction): Sep6AnchorAdapter {
  const { adapter } = build();
  jest
    .spyOn(
      adapter as unknown as {
        getTransaction(id: string): Promise<TransferTransaction>;
      },
      'getTransaction',
    )
    .mockResolvedValue(txn);
  return adapter;
}

/** Resumes a settlement whose withdraw is already open (anchorRef set) — by default also paid. */
function resume(
  adapter: Sep6AnchorAdapter,
  settlement: Partial<SettlementAnchorState> = {},
  save: jest.Mock = jest.fn(),
): Promise<SettleResult> {
  return adapter.settleToTRY({
    settlement: {
      id: 's1',
      amountUSDC: new Decimal('1.0328382'),
      anchorRef: 'sep_am7c6x92na0mgr3v5k2r',
      interactiveUrl: null,
      anchorStatus: null,
      anchorTxHash: 'hash',
      anchorTxXdr: 'xdr',
      ...settlement,
    },
    merchant: { id: 'm1', iban: IBAN } as Merchant,
    save,
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const info = (over: Record<string, unknown> = {}) =>
  json({
    withdraw: {
      USDC: { enabled: true, min_amount: 0.5, max_amount: 300, ...over },
    },
  });
const opened = () =>
  json({
    id: 'sep_am7c6x92na0mgr3v5k2r',
    account_id: 'GCLCZEQZ2THTEDAOFI66LACNPLY4OBKN7VKLEZFMBIHYKYQOW2W7T3Z6',
    memo_type: 'id',
    memo: '869671972907',
  });

interface Internals {
  start(
    state: SettlementAnchorState,
    merchant: Merchant,
    persist: jest.Mock,
  ): Promise<SettleResult | null>;
}

const pending: SettlementAnchorState = {
  id: 's1',
  amountUSDC: new Decimal('1.0328382'),
  anchorRef: null,
  interactiveUrl: null,
  anchorStatus: null,
  anchorTxHash: null,
  anchorTxXdr: null,
};

afterEach(() => jest.restoreAllMocks());

describe('Sep6AnchorAdapter — opening the withdraw', () => {
  it('opens it as a GET with the SEP-6 query params and records only anchorRef', async () => {
    const { adapter } = build();
    const fetch = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(info())
      .mockResolvedValueOnce(opened());
    const persist = jest.fn();

    expect(
      await (adapter as unknown as Internals).start(
        pending,
        {
          id: 'm1',
          iban: IBAN,
        } as Merchant,
        persist,
      ),
    ).toBeNull();

    const [url, init] = fetch.mock.calls[1];
    const query = new URL(url as string).searchParams;
    expect(new URL(url as string).pathname).toBe('/sep6/withdraw');
    expect(init?.method ?? 'GET').toBe('GET');
    expect(Object.fromEntries(query)).toMatchObject({
      asset_code: 'USDC',
      type: 'bank_account',
      amount: '1.0328382',
      dest: IBAN,
    });
    expect(query.get('account')).toMatch(/^G[A-Z2-7]{55}$/);
    expect(init?.headers).toEqual({ authorization: 'Bearer jwt' });
    // SEP-6 is programmatic: there is no interactive URL to persist.
    expect(persist).toHaveBeenCalledWith({
      anchorRef: 'sep_am7c6x92na0mgr3v5k2r',
    });
  });

  it('blocks without an IBAN, before touching the anchor', async () => {
    const { adapter } = build();
    const fetch = jest.spyOn(globalThis, 'fetch');

    expect(
      await (adapter as unknown as Internals).start(
        pending,
        { id: 'm1', iban: null } as Merchant,
        jest.fn(),
      ),
    ).toEqual({
      status: 'blocked',
      reason: 'missing_iban',
      detail: 'merchant m1 has no IBAN for the anchor payout',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['below the minimum', { min_amount: 2 }, 'below the anchor minimum 2'],
    ['above the maximum', { max_amount: 1 }, 'above the anchor maximum 1'],
    ['disabled', { enabled: false }, 'withdraw disabled for USDC'],
  ])(
    'blocks when /info says the amount is %s',
    async (_label, over, detail) => {
      const { adapter } = build();
      const fetch = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(info(over));

      const result = await (adapter as unknown as Internals).start(
        pending,
        { id: 'm1', iban: IBAN } as Merchant,
        jest.fn(),
      );
      expect(result).toMatchObject({ status: 'blocked' });
      expect(result && 'detail' in result && result.detail).toContain(detail);
      // Only /info was called — no withdraw was opened.
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('blocks when the anchor rejects the amount, even though /info allowed it', async () => {
    // tr-mock-anchor advertises min_amount 0.5 but enforces 1 USDC — it only says so here.
    const { adapter } = build();
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(info())
      .mockResolvedValueOnce(
        json({ error: 'Minimum off-ramp is 1.0000000 USDC' }, 400),
      );
    const persist = jest.fn();

    const result = await (adapter as unknown as Internals).start(
      { ...pending, amountUSDC: new Decimal('0.7230000') },
      { id: 'm1', iban: IBAN } as Merchant,
      persist,
    );
    expect(result).toMatchObject({
      status: 'blocked',
      reason: 'outside_anchor_limits',
    });
    expect(result && 'detail' in result && result.detail).toContain(
      'Minimum off-ramp is 1.0000000 USDC',
    );
    expect(persist).not.toHaveBeenCalled();
  });

  it('lets an unrelated anchor error propagate as transient, rather than blocking', async () => {
    const { adapter } = build();
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(info())
      .mockResolvedValueOnce(json({ error: 'database is down' }, 500));

    await expect(
      (adapter as unknown as Internals).start(
        pending,
        { id: 'm1', iban: IBAN } as Merchant,
        jest.fn(),
      ),
    ).rejects.toThrow('500');
  });
});

describe('Sep6AnchorAdapter — following the withdraw', () => {
  it('completes with the TRY the anchor says it paid out, and never exposes an interactiveUrl', async () => {
    const save = jest.fn();
    const result = await resume(
      adapterSeeing({
        id: 'sep_am7c6x92na0mgr3v5k2r',
        status: 'completed',
        amount_in: '1.0328382',
        amount_in_asset: OUR_USDC,
        amount_out: '50.00',
        amount_out_asset: TRY,
        amount_fee: '0.25',
        amount_fee_asset: TRY,
      }),
      {},
      save,
    );
    expect(result).toMatchObject({
      status: 'completed',
      ref: 'sep_am7c6x92na0mgr3v5k2r',
    });
    expect(result.status === 'completed' && result.netTRY?.toFixed(2)).toBe(
      '50.00',
    );
    expect(result.status === 'completed' && result.feeUSDC.toFixed(7)).toBe(
      '0.0000000',
    );
    expect(save).toHaveBeenCalledWith({ anchorStatus: 'completed' });
    const persisted = save.mock.calls.map(
      ([patch]) => patch as Record<string, unknown>,
    );
    expect(persisted.some((patch) => 'interactiveUrl' in patch)).toBe(false);
  });

  it('omits netTRY when the anchor reports no TRY amount_out, leaving the fee math in charge', async () => {
    const result = await resume(
      adapterSeeing({
        id: 'sep_am7c6x92na0mgr3v5k2r',
        status: 'completed',
        fee_details: { total: '0.1', asset: OUR_USDC },
      }),
    );
    expect(result).toMatchObject({ status: 'completed' });
    expect(result.status === 'completed' && result.netTRY).toBeUndefined();
    expect(result.status === 'completed' && result.feeUSDC.toFixed(7)).toBe(
      '0.1000000',
    );
  });

  it('fails with unexpected_fee_asset when nothing can be credited honestly', async () => {
    const result = await resume(
      adapterSeeing({
        id: 'sep_am7c6x92na0mgr3v5k2r',
        status: 'completed',
        fee_details: { total: '0.1', asset: 'iso4217:USD' },
      }),
    );
    expect(result).toMatchObject({
      status: 'failed',
      reason: 'unexpected_fee_asset',
    });
  });

  it('fails with anchor_status when the anchor ends the withdrawal in error', async () => {
    const result = await resume(
      adapterSeeing({
        id: 'sep_am7c6x92na0mgr3v5k2r',
        status: 'error',
        message: 'bank rejected',
      }),
    );
    expect(result).toMatchObject({
      status: 'failed',
      reason: 'anchor_status',
      detail: 'anchor transaction error: bank rejected',
    });
  });

  it('rejects payoutTRY — a SEP-6 withdrawal already pays the merchant', async () => {
    const { adapter } = build();
    await expect(adapter.payoutTRY()).rejects.toThrow(
      'ANCHOR_PROVIDER=sep6 has no separate TRY payout',
    );
  });
});
