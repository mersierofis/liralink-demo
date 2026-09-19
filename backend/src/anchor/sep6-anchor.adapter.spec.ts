import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Keypair } from '@stellar/stellar-sdk';
import { Decimal } from '../common/decimal';
import type { Merchant } from '../generated/prisma/client';
import type { SettleResult, SettlementAnchorState } from './anchor.adapter';
import { AnchorSession } from './anchor-session';
import { anchorMemoFor } from './sep6';
import { Sep6AnchorAdapter } from './sep6-anchor.adapter';
import type { TransferTransaction } from './transfer';

const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const OUR_USDC = `stellar:USDC:${ISSUER}`;
const TRY = 'iso4217:TRY';
const HOME = 'tr-mock-anchor.fly.dev';
const TRANSFER = 'https://anchor.example/sep6';
const KYC = 'https://anchor.example/sep12';
const IBAN = 'TR330006100519786457841326';
const OTHER_IBAN = 'TR320010009999901234567890';
const MERCHANT_ID = '3f2b8c1e-9a4d-4e7b-8c21-5d6f7a8b9c0d';
const MEMO = anchorMemoFor(MERCHANT_ID);
const REF = 'sep_am7c6x92na0mgr3v5k2r';

/** A merchant the anchor has never seen. */
const newMerchant = (over: Partial<Merchant> = {}) =>
  ({
    id: MERCHANT_ID,
    iban: IBAN,
    sep12CustomerId: null,
    sep12Iban: null,
    sep12HomeDomain: null,
    ...over,
  }) as Merchant;
/** A merchant whose current IBAN is already registered at this anchor. */
const registeredMerchant = (over: Partial<Merchant> = {}) =>
  newMerchant({
    sep12CustomerId: 'cus_1',
    sep12Iban: IBAN,
    sep12HomeDomain: HOME,
    ...over,
  });

function build() {
  const settings = new ConfigService({
    ANCHOR_HOME_DOMAIN: HOME,
    PLATFORM_ACCOUNT_SECRET: Keypair.random().secret(),
    HORIZON_URL: 'https://horizon-testnet.stellar.org',
    NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
    USDC_CODE: 'USDC',
    USDC_ISSUER: ISSUER,
  });
  const session = new AnchorSession(settings);
  jest.spyOn(session, 'transferServer').mockResolvedValue(TRANSFER);
  jest.spyOn(session, 'endpoints').mockResolvedValue({
    transferServer: TRANSFER,
    transferServerSep24: null,
    quoteServer: null,
    kycServer: KYC,
    authEndpoint: 'https://anchor.example/auth',
    signingKey: Keypair.random().publicKey(),
    fetchedAt: Date.now(),
  });
  // A distinct token per identity, so a test can tell which anchor user made each call.
  const token = jest
    .spyOn(session, 'token')
    .mockImplementation((memo?: string) =>
      Promise.resolve(memo ? `jwt-${memo}` : 'jwt-omnibus'),
    );
  return { adapter: new Sep6AnchorAdapter(settings, session), token };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const info = (over: Record<string, unknown> = {}) =>
  json({
    withdraw: {
      USDC: { enabled: true, min_amount: 0.5, max_amount: 300, ...over },
    },
  });
const accepted = (id = 'cus_1') => json({ id, status: 'ACCEPTED' });
const registered = (id = 'cus_new') => json({ id }, 202);
const opened = () =>
  json({
    id: REF,
    account_id: 'GCLCZEQZ2THTEDAOFI66LACNPLY4OBKN7VKLEZFMBIHYKYQOW2W7T3Z6',
    memo_type: 'id',
    memo: '869671972907',
  });

interface Internals {
  start(
    state: SettlementAnchorState,
    merchant: Merchant,
    persist: jest.Mock,
    saveMerchant?: jest.Mock,
  ): Promise<SettleResult | null>;
  getTransaction(id: string, memo?: string): Promise<TransferTransaction>;
}

const pending: SettlementAnchorState = {
  id: 's1',
  amountUSDC: new Decimal('1.0328382'),
  anchorRef: null,
  interactiveUrl: null,
  anchorStatus: null,
  anchorTxHash: null,
  anchorTxXdr: null,
  anchorMemo: null,
};

/** Every fetch as `METHOD /path`, in order. */
const calls = (fetch: jest.SpyInstance) =>
  (fetch.mock.calls as [string, RequestInit | undefined][]).map(
    ([url, init]) => `${init?.method ?? 'GET'} ${new URL(url).pathname}`,
  );

afterEach(() => jest.restoreAllMocks());

describe('Sep6AnchorAdapter — opening the withdraw', () => {
  it('registers the IBAN, then opens the withdraw as the merchant’s own anchor user', async () => {
    const { adapter, token } = build();
    const fetch = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(info())
      .mockResolvedValueOnce(registered())
      .mockResolvedValueOnce(opened());
    const persist = jest.fn();
    const saveMerchant = jest.fn();

    expect(
      await (adapter as unknown as Internals).start(
        pending,
        newMerchant(),
        persist,
        saveMerchant,
      ),
    ).toBeNull();

    expect(calls(fetch)).toEqual([
      'GET /sep6/info',
      'PUT /sep12/customer',
      'GET /sep6/withdraw',
    ]);
    expect(token).toHaveBeenCalledWith(MEMO);

    const [, putInit] = fetch.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(putInit.body as string)).toEqual({
      bank_account_number: IBAN,
    });
    expect(putInit.headers).toMatchObject({
      authorization: `Bearer jwt-${MEMO}`,
    });
    expect(saveMerchant).toHaveBeenCalledWith({
      sep12CustomerId: 'cus_new',
      sep12Iban: IBAN,
      sep12HomeDomain: HOME,
    });

    const [url, init] = fetch.mock.calls[2] as [string, RequestInit];
    const query = new URL(url).searchParams;
    expect(Object.fromEntries(query)).toMatchObject({
      asset_code: 'USDC',
      funding_method: 'bank_account',
      amount: '1.0328382',
    });
    // `type` is deprecated in SEP-6 — never sent.
    expect(query.has('type')).toBe(false);
    // #39: the IBAN is registered over SEP-12, never put in the query string. Asserted on the
    // whole URL, not just `dest`, so no future parameter can smuggle it back in.
    expect(query.has('dest')).toBe(false);
    expect(url).not.toContain(IBAN);
    expect(query.get('account')).toMatch(/^G[A-Z2-7]{55}$/);
    expect(init.headers).toEqual({ authorization: `Bearer jwt-${MEMO}` });
    // The memo is saved with the ref — the anchor only shows this transaction to that user.
    expect(persist).toHaveBeenCalledWith({ anchorRef: REF, anchorMemo: MEMO });
  });

  it('only checks the customer (no PUT) when this IBAN is already registered at this anchor', async () => {
    const { adapter } = build();
    const fetch = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(info())
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(opened());
    const saveMerchant = jest.fn();

    await (adapter as unknown as Internals).start(
      pending,
      registeredMerchant(),
      jest.fn(),
      saveMerchant,
    );
    expect(calls(fetch)).toEqual([
      'GET /sep6/info',
      'GET /sep12/customer',
      'GET /sep6/withdraw',
    ]);
    expect(saveMerchant).not.toHaveBeenCalled();
  });

  it.each([
    ['the merchant changed their IBAN', { sep12Iban: OTHER_IBAN }],
    [
      'it was registered at another anchor',
      { sep12HomeDomain: 'testanchor.stellar.org' },
    ],
  ])('registers again when %s', async (_label, over) => {
    const { adapter } = build();
    const fetch = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(info())
      .mockResolvedValueOnce(registered('cus_2'))
      .mockResolvedValueOnce(opened());
    const saveMerchant = jest.fn();

    await (adapter as unknown as Internals).start(
      pending,
      registeredMerchant(over),
      jest.fn(),
      saveMerchant,
    );
    expect(calls(fetch)).toEqual([
      'GET /sep6/info',
      'PUT /sep12/customer',
      'GET /sep6/withdraw',
    ]);
    expect(saveMerchant).toHaveBeenCalledWith({
      sep12CustomerId: 'cus_2',
      sep12Iban: IBAN,
      sep12HomeDomain: HOME,
    });
  });

  it.each([
    ['NEEDS_INFO (sandbox reset)', { status: 'NEEDS_INFO' }],
    ['a different customer id', { id: 'cus_other', status: 'ACCEPTED' }],
  ])(
    'registers again when the anchor reports %s, rather than paying the default IBAN',
    async (_label, customer) => {
      const { adapter } = build();
      const fetch = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(info())
        .mockResolvedValueOnce(json(customer))
        .mockResolvedValueOnce(registered('cus_3'))
        .mockResolvedValueOnce(opened());

      await (adapter as unknown as Internals).start(
        pending,
        registeredMerchant(),
        jest.fn(),
        jest.fn(),
      );
      expect(calls(fetch)).toEqual([
        'GET /sep6/info',
        'GET /sep12/customer',
        'PUT /sep12/customer',
        'GET /sep6/withdraw',
      ]);
    },
  );

  it('blocks with missing_iban when the anchor rejects the IBAN — no withdraw opened', async () => {
    const { adapter } = build();
    const fetch = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(info())
      .mockResolvedValueOnce(
        json(
          {
            error:
              'bank_account_number must be a valid Turkish IBAN (TR + 24 digits)',
          },
          400,
        ),
      );
    const persist = jest.fn();
    const saveMerchant = jest.fn();

    const result = await (adapter as unknown as Internals).start(
      pending,
      newMerchant({ iban: 'TR000000000000000000000000' }),
      persist,
      saveMerchant,
    );
    expect(result).toMatchObject({ status: 'blocked', reason: 'missing_iban' });
    expect(result && 'detail' in result && result.detail).toContain(
      'valid Turkish IBAN',
    );
    expect(calls(fetch)).toEqual(['GET /sep6/info', 'PUT /sep12/customer']);
    expect(persist).not.toHaveBeenCalled();
    expect(saveMerchant).not.toHaveBeenCalled();
  });

  it('blocks without an IBAN, before touching the anchor', async () => {
    const { adapter } = build();
    const fetch = jest.spyOn(globalThis, 'fetch');

    expect(
      await (adapter as unknown as Internals).start(
        pending,
        newMerchant({ iban: null }),
        jest.fn(),
      ),
    ).toEqual({
      status: 'blocked',
      reason: 'missing_iban',
      detail: `merchant ${MERCHANT_ID} has no IBAN for the anchor payout`,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['below the minimum', { min_amount: 2 }, 'below the anchor minimum 2'],
    ['above the maximum', { max_amount: 1 }, 'above the anchor maximum 1'],
    ['disabled', { enabled: false }, 'withdraw disabled for USDC'],
  ])(
    'blocks when /info says the amount is %s — before any SEP-10 or SEP-12 call',
    async (_label, over, detail) => {
      const { adapter, token } = build();
      const fetch = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(info(over));

      const result = await (adapter as unknown as Internals).start(
        pending,
        newMerchant(),
        jest.fn(),
      );
      expect(result).toMatchObject({ status: 'blocked' });
      expect(result && 'detail' in result && result.detail).toContain(detail);
      expect(calls(fetch)).toEqual(['GET /sep6/info']);
      expect(token).not.toHaveBeenCalled();
    },
  );

  it('blocks when the anchor rejects the amount, even though /info allowed it', async () => {
    // tr-mock-anchor advertises min_amount 0.5 but enforces 1 USDC — it only says so here.
    const { adapter } = build();
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(info())
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(
        json({ error: 'Minimum off-ramp is 1.0000000 USDC' }, 400),
      );
    const persist = jest.fn();

    const result = await (adapter as unknown as Internals).start(
      { ...pending, amountUSDC: new Decimal('0.7230000') },
      registeredMerchant(),
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
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(json({ error: 'database is down' }, 500));

    await expect(
      (adapter as unknown as Internals).start(
        pending,
        registeredMerchant(),
        jest.fn(),
      ),
    ).rejects.toThrow('500');
  });
});

describe('Sep6AnchorAdapter — following the withdraw', () => {
  /** Resumes a settlement whose withdraw is already open (and paid), seeing `txn` at the anchor. */
  function resume(
    txn: Partial<TransferTransaction>,
    settlement: Partial<SettlementAnchorState> = {},
    save: jest.Mock = jest.fn(),
  ) {
    const { adapter } = build();
    const getTransaction = jest
      .spyOn(adapter as unknown as Internals, 'getTransaction')
      .mockResolvedValue({ id: REF, status: 'completed', ...txn });
    const result = adapter.settleToTRY({
      settlement: {
        ...pending,
        anchorRef: REF,
        anchorMemo: MEMO,
        anchorTxHash: 'hash',
        anchorTxXdr: 'xdr',
        ...settlement,
      },
      merchant: registeredMerchant(),
      save,
    });
    return { result, getTransaction };
  }

  const paidOut = {
    amount_in: '1.0328382',
    amount_in_asset: OUR_USDC,
    amount_out: '50.00',
    amount_out_asset: TRY,
    amount_fee: '0.25',
    amount_fee_asset: TRY,
    to: IBAN,
    external_transaction_id: 'FAST-20260916-123',
  };

  it('polls as the anchor user that opened the withdrawal', async () => {
    const { result, getTransaction } = resume(paidOut);
    await result;
    expect(getTransaction).toHaveBeenCalledWith(REF, MEMO);
  });

  it('polls a withdrawal opened before per-merchant identity as the bare platform account', async () => {
    const { result, getTransaction } = resume(paidOut, { anchorMemo: null });
    await result;
    expect(getTransaction).toHaveBeenCalledWith(REF, undefined);
  });

  it('completes with the TRY the anchor says it paid out, and never exposes an interactiveUrl', async () => {
    const save = jest.fn();
    const { result } = resume(paidOut, {}, save);
    const settled = await result;
    expect(settled).toMatchObject({ status: 'completed', ref: REF });
    expect(settled.status === 'completed' && settled.netTRY?.toFixed(2)).toBe(
      '50.00',
    );
    expect(settled.status === 'completed' && settled.feeUSDC.toFixed(7)).toBe(
      '0.0000000',
    );
    expect(save).toHaveBeenCalledWith({ anchorStatus: 'completed' });
    const persisted = save.mock.calls.map(
      ([patch]) => patch as Record<string, unknown>,
    );
    expect(persisted.some((patch) => 'interactiveUrl' in patch)).toBe(false);
  });

  it('still completes when the anchor paid another IBAN, but logs it loudly for reconciliation', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const { result } = resume({ ...paidOut, to: 'TR120009904269670486500236' });

    // The money already moved — failing the settlement would not bring it back.
    expect(await result).toMatchObject({ status: 'completed' });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('not merchant') as string,
    );
  });

  it('omits netTRY when the anchor reports no TRY amount_out, leaving the fee math in charge', async () => {
    const { result } = resume({
      fee_details: { total: '0.1', asset: OUR_USDC },
    });
    const settled = await result;
    expect(settled).toMatchObject({ status: 'completed' });
    expect(settled.status === 'completed' && settled.netTRY).toBeUndefined();
  });

  it('fails with unexpected_fee_asset when nothing can be credited honestly', async () => {
    const { result } = resume({
      fee_details: { total: '0.1', asset: 'iso4217:USD' },
    });
    expect(await result).toMatchObject({
      status: 'failed',
      reason: 'unexpected_fee_asset',
    });
  });

  it('fails with anchor_status when the anchor ends the withdrawal in error', async () => {
    const { result } = resume({ status: 'error', message: 'bank rejected' });
    expect(await result).toMatchObject({
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
