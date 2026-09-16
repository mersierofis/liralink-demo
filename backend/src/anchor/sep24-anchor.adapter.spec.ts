import { ConfigService } from '@nestjs/config';
import { Keypair } from '@stellar/stellar-sdk';
import { Decimal } from '../common/decimal';
import type { Merchant } from '../generated/prisma/client';
import type { SettlementAnchorState } from './anchor.adapter';
import { AnchorSession } from './anchor-session';
import type { Sep24Transaction } from './sep24';
import { Sep24AnchorAdapter } from './sep24-anchor.adapter';

const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const OUR_USDC = `stellar:USDC:${ISSUER}`;

/** An adapter whose anchor always reports `txn` — no network involved. */
function adapterSeeing(
  txn: Sep24Transaction,
  config: Record<string, string> = {},
): Sep24AnchorAdapter {
  const settings = new ConfigService({
    ...config,
    ANCHOR_HOME_DOMAIN: 'testanchor.stellar.org',
    PLATFORM_ACCOUNT_SECRET: Keypair.random().secret(),
    HORIZON_URL: 'https://horizon-testnet.stellar.org',
    NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
    USDC_CODE: 'USDC',
    USDC_ISSUER: ISSUER,
  });
  const adapter = new Sep24AnchorAdapter(settings, new AnchorSession(settings));
  jest
    .spyOn(
      adapter as unknown as {
        getTransaction(id: string): Promise<Sep24Transaction>;
      },
      'getTransaction',
    )
    .mockResolvedValue(txn);
  return adapter;
}

/** Resumes a settlement whose withdraw is already open (anchorRef set) — by default also paid. */
function resume(
  adapter: Sep24AnchorAdapter,
  settlement: Partial<SettlementAnchorState> = {},
  save: jest.Mock = jest.fn(),
) {
  return adapter.settleToTRY({
    settlement: {
      id: 's1',
      amountUSDC: new Decimal('1.0000000'),
      anchorRef: 'anchor-1',
      interactiveUrl: null,
      anchorStatus: null,
      anchorTxHash: 'hash',
      anchorTxXdr: 'xdr',
      ...settlement,
    },
    merchant: { iban: 'TR330006100519786457841326' } as Merchant,
    save,
  });
}

// SEP-1 discovery and SEP-10 auth now live in AnchorSession (shared with SEP-6) and are covered
// by `anchor-session.spec.ts`.

describe('Sep24AnchorAdapter — withdraw request encoding (form, never JSON)', () => {
  interface Internals {
    getEndpoints(): Promise<unknown>;
    token(): Promise<string>;
    start(
      state: SettlementAnchorState,
      merchant: Merchant,
      persist: jest.Mock,
    ): Promise<unknown>;
  }
  const FIELDS = ['asset_code', 'asset_issuer', 'account', 'amount', 'lang'];
  const state: SettlementAnchorState = {
    id: 's1',
    amountUSDC: new Decimal('1.0000000'),
    anchorRef: null,
    interactiveUrl: null,
    anchorStatus: null,
    anchorTxHash: null,
    anchorTxXdr: null,
  };
  const merchant = {
    id: 'm1',
    iban: 'TR330006100519786457841326',
  } as Merchant;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });
  const info = () =>
    json({
      withdraw: { USDC: { enabled: true, min_amount: 1, max_amount: 10 } },
    });
  const opened = () =>
    json({ id: 'anchor-1', url: 'https://anchor.example/w?token=t' });

  function setup(config: Record<string, string> = {}) {
    const adapter = adapterSeeing(
      { id: 'anchor-1', status: 'incomplete' },
      config,
    ) as unknown as Internals;
    jest.spyOn(adapter, 'getEndpoints').mockResolvedValue({
      transferServer: 'https://anchor.example/sep24',
      authEndpoint: 'https://anchor.example/auth',
      signingKey: Keypair.random().publicKey(),
      fetchedAt: Date.now(),
    });
    jest.spyOn(adapter, 'token').mockResolvedValue('jwt');
    const fetch = jest.spyOn(globalThis, 'fetch');
    /** The init of every POST /transactions/withdraw/interactive, in order. */
    const withdraws = () =>
      fetch.mock.calls
        // The adapter always calls fetch with a string URL.
        .filter(([url]) =>
          (url as string).endsWith('/transactions/withdraw/interactive'),
        )
        .map(([, init]) => init!);
    return { adapter, fetch, withdraws };
  }

  afterEach(() => jest.restoreAllMocks());

  it('opens the withdraw as multipart/form-data with the SEP-24 fields', async () => {
    const { adapter, fetch, withdraws } = setup();
    fetch.mockResolvedValueOnce(info()).mockResolvedValueOnce(opened());
    const persist = jest.fn();

    expect(await adapter.start(state, merchant, persist)).toBeNull();
    const [init] = withdraws();
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(Object.fromEntries(FIELDS.map((k) => [k, form.get(k)]))).toEqual({
      asset_code: 'USDC',
      asset_issuer: ISSUER,
      account: form.get('account'),
      amount: '1.0000000',
      lang: 'en',
    });
    expect(form.get('account')).toMatch(/^G[A-Z2-7]{55}$/);
    // No JSON content type — fetch sets multipart/form-data with the boundary.
    expect(init.headers).toEqual({ authorization: 'Bearer jwt' });
    expect(persist).toHaveBeenCalledWith({
      anchorRef: 'anchor-1',
      interactiveUrl: 'https://anchor.example/w?token=t',
    });
  });

  it.each([400, 415, 422])(
    'retries urlencoded when the anchor rejects multipart with %i, and keeps urlencoded',
    async (status) => {
      const { adapter, fetch, withdraws } = setup();
      fetch
        .mockResolvedValueOnce(info())
        .mockResolvedValueOnce(
          json({ error: 'asset_code is required' }, status),
        )
        .mockResolvedValueOnce(opened())
        .mockResolvedValueOnce(info())
        .mockResolvedValueOnce(opened());

      expect(await adapter.start(state, merchant, jest.fn())).toBeNull();
      expect(await adapter.start(state, merchant, jest.fn())).toBeNull();

      const [first, retry, next] = withdraws();
      expect(first.body).toBeInstanceOf(FormData);
      expect(retry.body).toBeInstanceOf(URLSearchParams);
      expect(Object.fromEntries(retry.body as URLSearchParams)).toMatchObject({
        asset_code: 'USDC',
        asset_issuer: ISSUER,
        amount: '1.0000000',
        lang: 'en',
      });
      expect(retry.headers).toEqual({ authorization: 'Bearer jwt' });
      expect(next.body).toBeInstanceOf(URLSearchParams);
      expect(withdraws()).toHaveLength(3);
    },
  );

  it.each([401, 403, 500, 503])(
    'does not retry on %i — one withdraw request, the error propagates',
    async (status) => {
      const { adapter, fetch, withdraws } = setup();
      fetch
        .mockResolvedValueOnce(info())
        .mockResolvedValueOnce(json({ error: 'nope' }, status));

      await expect(adapter.start(state, merchant, jest.fn())).rejects.toThrow(
        String(status),
      );
      expect(withdraws()).toHaveLength(1);
    },
  );

  it('stays on multipart when the urlencoded retry is rejected too', async () => {
    const { adapter, fetch, withdraws } = setup();
    fetch
      .mockResolvedValueOnce(info())
      .mockResolvedValueOnce(json({ error: 'amount too small' }, 400))
      .mockResolvedValueOnce(json({ error: 'amount too small' }, 400))
      .mockResolvedValueOnce(info())
      .mockResolvedValueOnce(opened());

    await expect(adapter.start(state, merchant, jest.fn())).rejects.toThrow(
      '400',
    );
    expect(await adapter.start(state, merchant, jest.fn())).toBeNull();
    expect(withdraws().map((i) => i.body?.constructor.name)).toEqual([
      'FormData',
      'URLSearchParams',
      'FormData',
    ]);
  });

  it('starts with ANCHOR_SEP24_ENCODING=urlencoded and falls back to multipart on a 4xx', async () => {
    const { adapter, fetch, withdraws } = setup({
      ANCHOR_SEP24_ENCODING: 'urlencoded',
    });
    fetch
      .mockResolvedValueOnce(info())
      .mockResolvedValueOnce(opened())
      .mockResolvedValueOnce(info())
      .mockResolvedValueOnce(json({ error: 'asset_code is required' }, 400))
      .mockResolvedValueOnce(opened())
      .mockResolvedValueOnce(info())
      .mockResolvedValueOnce(opened());

    for (let run = 0; run < 3; run++) {
      expect(await adapter.start(state, merchant, jest.fn())).toBeNull();
    }
    expect(withdraws().map((i) => i.body?.constructor.name)).toEqual([
      'URLSearchParams',
      'URLSearchParams',
      'FormData',
      'FormData',
    ]);
  });

  it.each([
    ['multipart', 'FormData', 'URLSearchParams'],
    ['urlencoded', 'URLSearchParams', 'FormData'],
  ])(
    'tries the other format once on a 5xx that mentions Content-Type (starting %s)',
    async (encoding, first, other) => {
      const { adapter, fetch, withdraws } = setup({
        ANCHOR_SEP24_ENCODING: encoding,
      });
      fetch
        .mockResolvedValueOnce(info())
        .mockResolvedValueOnce(
          json({ error: "Content-Type 'text/x' is not supported" }, 500),
        )
        .mockResolvedValueOnce(opened());

      expect(await adapter.start(state, merchant, jest.fn())).toBeNull();
      expect(withdraws().map((i) => i.body?.constructor.name)).toEqual([
        first,
        other,
      ]);
    },
  );
});

describe('Sep24AnchorAdapter — interactive step at a real anchor (no test KYC URL)', () => {
  const waiting = {
    interactiveUrl: 'https://anchor.example/withdraw?token=t',
    anchorTxHash: null,
    anchorTxXdr: null,
  };

  it('stays processing, records anchorStatus once, and never fills the form itself', async () => {
    const adapter = adapterSeeing({ id: 'anchor-1', status: 'incomplete' });
    const submit = jest.spyOn(
      adapter as unknown as { submitTestKyc(): Promise<void> },
      'submitTestKyc',
    );

    const save = jest.fn();
    expect(await resume(adapter, waiting, save)).toEqual({
      status: 'processing',
      ref: 'anchor-1',
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ anchorStatus: 'incomplete' });

    // The next minute's run: nothing changed at the anchor → no write, still processing.
    const again = jest.fn();
    expect(
      await resume(adapter, { ...waiting, anchorStatus: 'incomplete' }, again),
    ).toEqual({ status: 'processing', ref: 'anchor-1' });
    expect(again).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('resumes once the anchor reports the form complete', async () => {
    const save = jest.fn();
    const result = await resume(
      adapterSeeing({
        id: 'anchor-1',
        status: 'completed',
        fee_details: { total: '0', asset: OUR_USDC },
      }),
      { interactiveUrl: waiting.interactiveUrl, anchorStatus: 'incomplete' },
      save,
    );
    expect(save).toHaveBeenCalledWith({ anchorStatus: 'completed' });
    expect(result).toMatchObject({ status: 'completed', ref: 'anchor-1' });
  });
});

describe('Sep24AnchorAdapter — completed withdraw', () => {
  it('fails with unexpected_fee_asset when the fee is in another asset (returned, not thrown)', async () => {
    const result = await resume(
      adapterSeeing({
        id: 'anchor-1',
        status: 'completed',
        fee_details: { total: '0.1', asset: 'iso4217:USD' },
      }),
    );
    expect(result).toMatchObject({
      status: 'failed',
      ref: 'anchor-1',
      reason: 'unexpected_fee_asset',
    });
    expect(result.status === 'failed' && result.detail).toContain(
      'iso4217:USD',
    );
  });

  it('completes with the fee when it is in our USDC', async () => {
    const result = await resume(
      adapterSeeing({
        id: 'anchor-1',
        status: 'completed',
        fee_details: { total: '0.1', asset: OUR_USDC },
      }),
    );
    expect(result).toMatchObject({ status: 'completed', ref: 'anchor-1' });
    expect(result.status === 'completed' && result.feeUSDC.toFixed(7)).toBe(
      '0.1000000',
    );
  });

  it('fails with anchor_status when the anchor ends the withdraw in error', async () => {
    const result = await resume(
      adapterSeeing({
        id: 'anchor-1',
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
});
