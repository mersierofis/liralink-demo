import { ConfigService } from '@nestjs/config';
import { Keypair, StellarToml, WebAuth } from '@stellar/stellar-sdk';
import {
  AnchorEndpoints,
  AnchorHttpError,
  AnchorSession,
  redactIbans,
} from './anchor-session';

const PASSPHRASE = 'Test SDF Network ; September 2015';
const HOME = 'testanchor.stellar.org';

/** The SEP-1 / SEP-10 half of every anchor adapter (SEP-6 and SEP-24 share this session). */
describe('AnchorSession — SEP-1 / SEP-10 conformance', () => {
  interface Internals {
    jwts: Map<string, { token: string; expiresAt: number }>;
    endpoints(): Promise<{ authEndpoint: string; signingKey: string }>;
  }

  const make = (config: Record<string, string> = {}) =>
    new AnchorSession(
      new ConfigService({
        ANCHOR_HOME_DOMAIN: HOME,
        PLATFORM_ACCOUNT_SECRET: Keypair.random().secret(),
        NETWORK_PASSPHRASE: PASSPHRASE,
        ...config,
      }),
    );

  const toml = (signingKey: string, extra: Record<string, string> = {}) => ({
    TRANSFER_SERVER: 'https://anchor.example/sep6',
    TRANSFER_SERVER_SEP0024: 'https://anchor.example/sep24',
    ANCHOR_QUOTE_SERVER: 'https://anchor.example/sep38',
    KYC_SERVER: 'https://anchor.example/sep12',
    WEB_AUTH_ENDPOINT: 'https://anchor.example/auth',
    SIGNING_KEY: signingKey,
    ...extra,
  });

  const endpointsFor = (signingKey: string): AnchorEndpoints => ({
    transferServer: null,
    transferServerSep24: null,
    quoteServer: null,
    kycServer: null,
    authEndpoint: 'https://anchor.example/auth',
    signingKey,
    fetchedAt: Date.now(),
  });

  afterEach(() => jest.restoreAllMocks());

  it('reads stellar.toml with a timeout, re-reads it hourly, and drops every JWT when SIGNING_KEY rotates', async () => {
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
    expect(resolve).toHaveBeenCalledWith(HOME, { timeout: 20_000 });

    session.jwts.set('', { token: 'omnibus', expiresAt: now + 3_600_000 });
    session.jwts.set('42', { token: 'merchant', expiresAt: now + 3_600_000 });
    now += 60 * 60_000;
    expect((await session.endpoints()).signingKey).toBe(newKey);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(session.jwts.size).toBe(0);
  });

  it('exposes both transfer servers, the quote server and the KYC server from one toml read', async () => {
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
    const endpoints = await session.endpoints();
    expect(endpoints.quoteServer).toBe('https://anchor.example/sep38');
    expect(endpoints.kycServer).toBe('https://anchor.example/sep12');
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
    jest
      .spyOn(session, 'endpoints')
      .mockResolvedValue(endpointsFor(Keypair.random().publicKey()));
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

    internals.jwts.set('42', {
      token: 'jwt',
      expiresAt: Date.now() + 3_600_000,
    });
    internals.jwts.set('43', {
      token: 'other',
      expiresAt: Date.now() + 3_600_000,
    });
    fetch.mockResolvedValueOnce(
      new Response('{"error":"down"}', { status: 503 }),
    );
    await expect(session.request(url, { token: 'jwt' })).rejects.toThrow('503');
    expect(internals.jwts.get('42')?.token).toBe('jwt');

    fetch.mockResolvedValueOnce(
      new Response('{"type":"authentication_required"}', { status: 403 }),
    );
    await expect(session.request(url, { token: 'jwt' })).rejects.toThrow('403');
    // Only the rejected identity is dropped — another merchant's session is untouched.
    expect(internals.jwts.has('42')).toBe(false);
    expect(internals.jwts.get('43')?.token).toBe('other');
  });
});

/** Issue #21: one anchor user per merchant on the shared platform account. */
describe('AnchorSession — per-merchant SEP-10 identity (memo)', () => {
  const make = () =>
    new AnchorSession(
      new ConfigService({
        ANCHOR_HOME_DOMAIN: HOME,
        PLATFORM_ACCOUNT_SECRET: Keypair.random().secret(),
        NETWORK_PASSPHRASE: PASSPHRASE,
      }),
    );
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });
  const fakeJwt = (sub: string) =>
    `h.${Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.s`;

  function fakeAnchor(
    session: AnchorSession,
    opts: {
      challengeMemo?: (asked: string | null) => string | null;
      issueSub?: (account: string, asked: string | null) => string;
    } = {},
  ) {
    const server = Keypair.random();
    jest.spyOn(session, 'endpoints').mockResolvedValue({
      transferServer: null,
      transferServerSep24: null,
      quoteServer: null,
      kycServer: null,
      authEndpoint: 'https://anchor.example/auth',
      signingKey: server.publicKey(),
      fetchedAt: Date.now(),
    });
    const challengeUrls: URL[] = [];
    let asked: string | null = null;
    const fetch = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input, init) => {
        if ((init?.method ?? 'GET') === 'GET') {
          const url = new URL(input as string);
          challengeUrls.push(url);
          asked = url.searchParams.get('memo');
          const memo = opts.challengeMemo ? opts.challengeMemo(asked) : asked;
          return Promise.resolve(
            json({
              transaction: WebAuth.buildChallengeTx(
                server,
                session.account(),
                HOME,
                300,
                PASSPHRASE,
                'anchor.example',
                memo,
              ),
            }),
          );
        }
        const account = session.account();
        const sub = opts.issueSub
          ? opts.issueSub(account, asked)
          : asked
            ? `${account}:${asked}`
            : account;
        return Promise.resolve(json({ token: fakeJwt(sub) }));
      });
    return { fetch, challengeUrls };
  }

  afterEach(() => jest.restoreAllMocks());

  it('asks for the challenge with the memo and accepts a JWT whose sub is G…:memo', async () => {
    const session = make();
    const { challengeUrls } = fakeAnchor(session);

    const token = await session.token('4242001');
    expect(challengeUrls[0].searchParams.get('memo')).toBe('4242001');
    expect(challengeUrls[0].searchParams.get('account')).toBe(
      session.account(),
    );
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString(),
    ) as { sub: string };
    expect(payload.sub).toBe(`${session.account()}:4242001`);
  });

  it('caches one JWT per memo — two merchants never share a session', async () => {
    const session = make();
    const { challengeUrls } = fakeAnchor(session);

    const a = await session.token('4242001');
    const b = await session.token('4242002');
    const omnibus = await session.token();
    expect(new Set([a, b, omnibus]).size).toBe(3);
    expect(await session.token('4242001')).toBe(a);
    expect(await session.token()).toBe(omnibus);
    // One challenge per identity, none for the cached repeats.
    expect(challengeUrls.map((u) => u.searchParams.get('memo'))).toEqual([
      '4242001',
      '4242002',
      null,
    ]);
  });

  it('refuses a JWT whose sub ignores the memo — it would merge every merchant into one anchor user', async () => {
    const session = make();
    fakeAnchor(session, { issueSub: (account) => account });

    await expect(session.token('4242001')).rejects.toThrow(
      `issued a JWT for "${session.account()}", expected "${session.account()}:4242001"`,
    );
    // Not cached: the next call negotiates again rather than reusing the wrong identity.
    await expect(session.token('4242001')).rejects.toThrow('issued a JWT');
  });

  it('refuses to sign a challenge that does not carry the memo it was asked for', async () => {
    const session = make();
    const { fetch } = fakeAnchor(session, { challengeMemo: () => null });

    await expect(session.token('4242001')).rejects.toThrow(
      'challenge carries memo none, asked for 4242001',
    );
    // Only the challenge GET — nothing was signed and posted.
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

/** #39: an anchor echoes what we send it, and SEP-12 sends the merchant's bank account number. */
describe('redactIbans', () => {
  const IBAN = 'TR330006100519786457841326';

  it('redacts an IBAN an anchor echoed back', () => {
    expect(redactIbans(`invalid bank_account_number: ${IBAN}`)).toBe(
      'invalid bank_account_number: [redacted-iban]',
    );
  });

  it('redacts every occurrence, and other countries too', () => {
    expect(redactIbans(`${IBAN} and DE89370400440532013000 and ${IBAN}`)).toBe(
      '[redacted-iban] and [redacted-iban] and [redacted-iban]',
    );
  });

  it.each([
    ['account id', 'GBRZSG7K6ZXJRCMYM2O2HO2DKR7RO2ACZ5FARBMQZBB4YZMDFDXFUTV7'],
    ['contract id', 'CDKZYQI4NWBZB5DDAHFP6RXHFHFHBQEBXPL43PWJRTGNCFJ4Q6Z745EJ'],
    ['tx hash', 'a3f1c0de'.repeat(8)],
    [
      'asset id',
      'stellar:USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    ],
  ])('leaves a Stellar %s alone', (_what, value) => {
    expect(redactIbans(`anchor said ${value} is wrong`)).toContain(value);
  });

  it('leaves text with no IBAN untouched', () => {
    const body = 'Minimum off-ramp is 1.0000000 USDC';
    expect(redactIbans(body)).toBe(body);
  });
});

/** The redaction is applied once, at the error boundary, so no caller has to remember. */
describe('AnchorHttpError', () => {
  const IBAN = 'TR330006100519786457841326';

  it('redacts the IBAN from both the body and the message', () => {
    const err = new AnchorHttpError(
      400,
      `{"error":"bad IBAN ${IBAN}"}`,
      `PUT /sep12/customer \u2192 400: {"error":"bad IBAN ${IBAN}"}`,
    );
    expect(err.body).not.toContain(IBAN);
    expect(err.message).not.toContain(IBAN);
    expect(err.body).toContain('[redacted-iban]');
    expect(err.message).toContain('[redacted-iban]');
    // Everything a human needs to act on survives.
    expect(err.status).toBe(400);
    expect(err.message).toContain('PUT /sep12/customer');
  });

  it('keeps the words the amount-rejection check greps for', () => {
    const err = new AnchorHttpError(
      400,
      '{"error":"Minimum off-ramp is 1.0000000 USDC"}',
      'GET /sep6/withdraw \u2192 400',
    );
    expect(/minimum|maximum|amount|limit|small|large/i.test(err.body)).toBe(
      true,
    );
  });
});
