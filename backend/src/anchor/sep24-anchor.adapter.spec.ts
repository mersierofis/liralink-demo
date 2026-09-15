import { ConfigService } from '@nestjs/config';
import { Keypair, StellarToml } from '@stellar/stellar-sdk';
import { Decimal } from '../common/decimal';
import type { Merchant } from '../generated/prisma/client';
import type { SettlementAnchorState } from './anchor.adapter';
import type { Sep24Transaction } from './sep24';
import { Sep24AnchorAdapter } from './sep24-anchor.adapter';

const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const OUR_USDC = `stellar:USDC:${ISSUER}`;

/** An adapter whose anchor always reports `txn` — no network involved. */
function adapterSeeing(txn: Sep24Transaction): Sep24AnchorAdapter {
  const adapter = new Sep24AnchorAdapter(
    new ConfigService({
      ANCHOR_HOME_DOMAIN: 'testanchor.stellar.org',
      PLATFORM_ACCOUNT_SECRET: Keypair.random().secret(),
      HORIZON_URL: 'https://horizon-testnet.stellar.org',
      NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
      USDC_CODE: 'USDC',
      USDC_ISSUER: ISSUER,
    }),
  );
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

describe('Sep24AnchorAdapter — SEP-1 / SEP-10 conformance', () => {
  interface Internals {
    jwt: { token: string; expiresAt: number } | null;
    getEndpoints(): Promise<{ authEndpoint: string; signingKey: string }>;
    token(): Promise<string>;
    request(url: string, init?: { token?: string }): Promise<unknown>;
  }
  const make = () =>
    adapterSeeing({
      id: 'anchor-1',
      status: 'incomplete',
    }) as unknown as Internals;
  const toml = (signingKey: string) => ({
    TRANSFER_SERVER_SEP0024: 'https://anchor.example/sep24',
    WEB_AUTH_ENDPOINT: 'https://anchor.example/auth',
    SIGNING_KEY: signingKey,
  });

  afterEach(() => jest.restoreAllMocks());

  it('reads stellar.toml with a timeout, re-reads it hourly, and drops the JWT when SIGNING_KEY rotates', async () => {
    const oldKey = Keypair.random().publicKey();
    const newKey = Keypair.random().publicKey();
    const resolve = jest
      .spyOn(StellarToml.Resolver, 'resolve')
      .mockResolvedValueOnce(toml(oldKey))
      .mockResolvedValueOnce(toml(newKey));
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const adapter = make();

    await adapter.getEndpoints();
    await adapter.getEndpoints();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('testanchor.stellar.org', {
      timeout: 20_000,
    });

    adapter.jwt = { token: 'issued-under-old-key', expiresAt: now + 3_600_000 };
    now += 60 * 60_000;
    expect((await adapter.getEndpoints()).signingKey).toBe(newKey);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(adapter.jwt).toBeNull();
  });

  it('refuses to sign a SEP-10 challenge that names another network', async () => {
    const adapter = make();
    jest.spyOn(adapter, 'getEndpoints').mockResolvedValue({
      authEndpoint: 'https://anchor.example/auth',
      signingKey: Keypair.random().publicKey(),
    });
    const request = jest.spyOn(adapter, 'request').mockResolvedValue({
      transaction: 'not-even-xdr',
      network_passphrase: 'Public Global Stellar Network ; September 2015',
    });
    // Rejected on the passphrase, before the challenge is parsed or anything is signed or posted.
    await expect(adapter.token()).rejects.toThrow(
      'SEP-10 challenge is for "Public Global Stellar Network ; September 2015"',
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('forgets a JWT the anchor rejects with 401/403, keeps it on other errors', async () => {
    const adapter = make();
    const fetch = jest.spyOn(globalThis, 'fetch');
    const url = 'https://anchor.example/sep24/transaction?id=1';

    adapter.jwt = { token: 'jwt', expiresAt: Date.now() + 3_600_000 };
    fetch.mockResolvedValueOnce(
      new Response('{"error":"down"}', { status: 503 }),
    );
    await expect(adapter.request(url, { token: 'jwt' })).rejects.toThrow('503');
    expect(adapter.jwt?.token).toBe('jwt');

    fetch.mockResolvedValueOnce(
      new Response('{"type":"authentication_required"}', { status: 403 }),
    );
    await expect(adapter.request(url, { token: 'jwt' })).rejects.toThrow('403');
    expect(adapter.jwt).toBeNull();
  });
});

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

  function setup() {
    const adapter = adapterSeeing({
      id: 'anchor-1',
      status: 'incomplete',
    }) as unknown as Internals;
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
