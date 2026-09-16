import { ConfigService } from '@nestjs/config';
import { Keypair, StellarToml } from '@stellar/stellar-sdk';
import { AnchorSession } from './anchor-session';

const PASSPHRASE = 'Test SDF Network ; September 2015';

/** The SEP-1 / SEP-10 half of every anchor adapter (SEP-6 and SEP-24 share this session). */
describe('AnchorSession — SEP-1 / SEP-10 conformance', () => {
  interface Internals {
    jwt: { token: string; expiresAt: number } | null;
    endpoints(): Promise<{ authEndpoint: string; signingKey: string }>;
  }

  const make = (config: Record<string, string> = {}) =>
    new AnchorSession(
      new ConfigService({
        ANCHOR_HOME_DOMAIN: 'testanchor.stellar.org',
        PLATFORM_ACCOUNT_SECRET: Keypair.random().secret(),
        NETWORK_PASSPHRASE: PASSPHRASE,
        ...config,
      }),
    );

  const toml = (signingKey: string, extra: Record<string, string> = {}) => ({
    TRANSFER_SERVER: 'https://anchor.example/sep6',
    TRANSFER_SERVER_SEP0024: 'https://anchor.example/sep24',
    ANCHOR_QUOTE_SERVER: 'https://anchor.example/sep38',
    WEB_AUTH_ENDPOINT: 'https://anchor.example/auth',
    SIGNING_KEY: signingKey,
    ...extra,
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
    const session = make() as unknown as Internals;

    await session.endpoints();
    await session.endpoints();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('testanchor.stellar.org', {
      timeout: 20_000,
    });

    session.jwt = { token: 'issued-under-old-key', expiresAt: now + 3_600_000 };
    now += 60 * 60_000;
    expect((await session.endpoints()).signingKey).toBe(newKey);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(session.jwt).toBeNull();
  });

  it('exposes both transfer servers and the quote server from one toml read', async () => {
    jest
      .spyOn(StellarToml.Resolver, 'resolve')
      .mockResolvedValue(toml(Keypair.random().publicKey()));
    const session = make();

    expect(await session.transferServer('sep6')).toBe(
      'https://anchor.example/sep6',
    );
    expect(await session.transferServer('sep24')).toBe(
      'https://anchor.example/sep24',
    );
    expect((await session.endpoints()).quoteServer).toBe(
      'https://anchor.example/sep38',
    );
  });

  it('refuses an anchor that serves the requested SEP from no transfer server', async () => {
    jest.spyOn(StellarToml.Resolver, 'resolve').mockResolvedValue({
      WEB_AUTH_ENDPOINT: 'https://anchor.example/auth',
      SIGNING_KEY: Keypair.random().publicKey(),
      TRANSFER_SERVER_SEP0024: 'https://anchor.example/sep24',
    });

    await expect(make().transferServer('sep6')).rejects.toThrow(
      'lacks TRANSFER_SERVER — it does not serve SEP6',
    );
  });

  it('refuses an anchor whose stellar.toml names another network', async () => {
    jest.spyOn(StellarToml.Resolver, 'resolve').mockResolvedValue(
      toml(Keypair.random().publicKey(), {
        NETWORK_PASSPHRASE: 'Public Global Stellar Network ; September 2015',
      }),
    );

    await expect(make().endpoints()).rejects.toThrow(
      'is on "Public Global Stellar Network ; September 2015"',
    );
  });

  it('refuses to sign a SEP-10 challenge that names another network', async () => {
    const session = make();
    jest.spyOn(session, 'endpoints').mockResolvedValue({
      transferServer: null,
      transferServerSep24: null,
      quoteServer: null,
      authEndpoint: 'https://anchor.example/auth',
      signingKey: Keypair.random().publicKey(),
      fetchedAt: Date.now(),
    });
    const request = jest.spyOn(session, 'request').mockResolvedValue({
      transaction: 'not-even-xdr',
      network_passphrase: 'Public Global Stellar Network ; September 2015',
    });
    // Rejected on the passphrase, before the challenge is parsed or anything is signed or posted.
    await expect(session.token()).rejects.toThrow(
      'SEP-10 challenge is for "Public Global Stellar Network ; September 2015"',
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('forgets a JWT the anchor rejects with 401/403, keeps it on other errors', async () => {
    const session = make();
    const internals = session as unknown as Internals;
    const fetch = jest.spyOn(globalThis, 'fetch');
    const url = 'https://anchor.example/sep6/transaction?id=1';

    internals.jwt = { token: 'jwt', expiresAt: Date.now() + 3_600_000 };
    fetch.mockResolvedValueOnce(
      new Response('{"error":"down"}', { status: 503 }),
    );
    await expect(session.request(url, { token: 'jwt' })).rejects.toThrow('503');
    expect(internals.jwt?.token).toBe('jwt');

    fetch.mockResolvedValueOnce(
      new Response('{"type":"authentication_required"}', { status: 403 }),
    );
    await expect(session.request(url, { token: 'jwt' })).rejects.toThrow('403');
    expect(internals.jwt).toBeNull();
  });
});
