import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Keypair, StellarToml, WebAuth } from '@stellar/stellar-sdk';

/** Every anchor call, including the stellar.toml fetch, gets this timeout. */
export const ANCHOR_HTTP_TIMEOUT_MS = 20_000;
/** stellar.toml is re-read this often, so a rotated SIGNING_KEY or moved endpoint needs no restart. */
const TOML_TTL_MS = 60 * 60_000;

export type FormEncoding = 'multipart' | 'urlencoded';

/** A non-2xx anchor response; `status` tells a rejected request from a transient failure. */
export class AnchorHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message: string,
  ) {
    super(message);
  }
}

/** The endpoints a stellar.toml advertises, as far as LiraLink reads them. */
export interface AnchorEndpoints {
  /** SEP-6 `TRANSFER_SERVER`. */
  transferServer: string | null;
  /** SEP-24 `TRANSFER_SERVER_SEP0024`. */
  transferServerSep24: string | null;
  /** SEP-38 `ANCHOR_QUOTE_SERVER`. */
  quoteServer: string | null;
  authEndpoint: string;
  signingKey: string;
  fetchedAt: number;
}

export interface AnchorRequestInit {
  method?: string;
  token?: string;
  body?: unknown;
  form?: { encoding: FormEncoding; fields: Record<string, string> };
}

/**
 * One anchor's SEP-1 discovery and SEP-10 session, shared by every adapter that talks to
 * `ANCHOR_HOME_DOMAIN` (SEP-6, SEP-24) and by the SEP-38 rate source. The stellar.toml and the
 * JWT are cached here, so those adapters share one negotiation instead of one each.
 */
@Injectable()
export class AnchorSession {
  readonly homeDomain: string;
  private readonly keypair: Keypair;
  private readonly networkPassphrase: string;
  private endpointsCache: AnchorEndpoints | null = null;
  private jwt: { token: string; expiresAt: number } | null = null;

  constructor(config: ConfigService) {
    this.homeDomain = config.get<string>('ANCHOR_HOME_DOMAIN') ?? '';
    this.keypair = Keypair.fromSecret(
      config.get<string>('PLATFORM_ACCOUNT_SECRET')!,
    );
    this.networkPassphrase = config.get<string>('NETWORK_PASSPHRASE')!;
  }

  account(): string {
    return this.keypair.publicKey();
  }

  /** Signs with the platform key — the custodial account that holds and sends the USDC. */
  sign(tx: { sign(kp: Keypair): void }): void {
    tx.sign(this.keypair);
  }

  /** SEP-1: the anchor's stellar.toml, re-read hourly. */
  async endpoints(): Promise<AnchorEndpoints> {
    const cached = this.endpointsCache;
    if (cached && Date.now() - cached.fetchedAt < TOML_TTL_MS) return cached;
    if (!this.homeDomain) {
      throw new Error('ANCHOR_HOME_DOMAIN is required to reach an anchor');
    }
    const toml = await StellarToml.Resolver.resolve(this.homeDomain, {
      timeout: ANCHOR_HTTP_TIMEOUT_MS,
    });
    const authEndpoint = toml.WEB_AUTH_ENDPOINT;
    const signingKey = toml.SIGNING_KEY;
    if (!authEndpoint || !signingKey) {
      throw new Error(
        `${this.homeDomain} stellar.toml lacks WEB_AUTH_ENDPOINT or SIGNING_KEY`,
      );
    }
    const anchorNetwork = toml.NETWORK_PASSPHRASE
      ? String(toml.NETWORK_PASSPHRASE)
      : null;
    if (anchorNetwork && anchorNetwork !== this.networkPassphrase) {
      throw new Error(
        `${this.homeDomain} is on "${toml.NETWORK_PASSPHRASE}", not "${this.networkPassphrase}"`,
      );
    }
    // A JWT issued under a rotated SIGNING_KEY is re-negotiated against the new one.
    if (cached && cached.signingKey !== signingKey) this.jwt = null;
    this.endpointsCache = {
      transferServer: trimSlash(toml.TRANSFER_SERVER),
      transferServerSep24: trimSlash(toml.TRANSFER_SERVER_SEP0024),
      quoteServer: trimSlash(toml.ANCHOR_QUOTE_SERVER),
      authEndpoint,
      signingKey,
      fetchedAt: Date.now(),
    };
    return this.endpointsCache;
  }

  /** The transfer server for `sep`, or a clear error naming what the toml is missing. */
  async transferServer(sep: 'sep6' | 'sep24'): Promise<string> {
    const e = await this.endpoints();
    const url = sep === 'sep6' ? e.transferServer : e.transferServerSep24;
    if (!url) {
      throw new Error(
        `${this.homeDomain} stellar.toml lacks ${
          sep === 'sep6' ? 'TRANSFER_SERVER' : 'TRANSFER_SERVER_SEP0024'
        } — it does not serve ${sep.toUpperCase()}`,
      );
    }
    return url;
  }

  /** SEP-10: the challenge is verified (anchor signature, home and web-auth domain, time bounds)
   * before the platform key signs it. Cached until a minute before `exp`. */
  async token(): Promise<string> {
    if (this.jwt && this.jwt.expiresAt > Date.now() + 60_000) {
      return this.jwt.token;
    }
    const { authEndpoint, signingKey } = await this.endpoints();
    const challenge = await this.request<{
      transaction: string;
      network_passphrase?: string;
    }>(
      `${authEndpoint}?${new URLSearchParams({
        account: this.keypair.publicKey(),
        home_domain: this.homeDomain,
      })}`,
    );
    // SEP-10: the challenge may name its network — never sign one meant for another network.
    if (
      challenge.network_passphrase &&
      challenge.network_passphrase !== this.networkPassphrase
    ) {
      throw new Error(
        `${this.homeDomain} SEP-10 challenge is for "${challenge.network_passphrase}", not "${this.networkPassphrase}"`,
      );
    }
    const { tx } = WebAuth.readChallengeTx(
      challenge.transaction,
      signingKey,
      this.networkPassphrase,
      this.homeDomain,
      new URL(authEndpoint).hostname,
    );
    tx.sign(this.keypair);
    const { token } = await this.request<{ token: string }>(authEndpoint, {
      method: 'POST',
      body: { transaction: tx.toXDR() },
    });
    this.jwt = { token, expiresAt: jwtExpiresAt(token) };
    return token;
  }

  async request<T>(url: string, init: AnchorRequestInit = {}): Promise<T> {
    const method = init.method ?? 'GET';
    const headers: Record<string, string> = {};
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    let body: string | FormData | URLSearchParams | undefined;
    if (init.form) {
      // No content-type header: fetch derives it from the body (with the multipart boundary).
      if (init.form.encoding === 'multipart') {
        body = new FormData();
        for (const [k, v] of Object.entries(init.form.fields))
          body.append(k, v);
      } else {
        body = new URLSearchParams(init.form.fields);
      }
    } else if (init.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(ANCHOR_HTTP_TIMEOUT_MS),
    });
    const text = await res.text();
    const path = new URL(url).pathname;
    if (!res.ok) {
      // The anchor no longer accepts our JWT (revoked or expired early): re-authenticate next call.
      if (
        (res.status === 401 || res.status === 403) &&
        init.token !== undefined &&
        init.token === this.jwt?.token
      ) {
        this.jwt = null;
      }
      throw new AnchorHttpError(
        res.status,
        text,
        `${method} ${path} → ${res.status}: ${text.slice(0, 300)}`,
      );
    }
    return JSON.parse(text) as T;
  }
}

function trimSlash(url: unknown): string | null {
  return typeof url === 'string' && url ? url.replace(/\/$/, '') : null;
}

/** `exp` of a JWT in ms; five minutes from now if it can't be read. */
export function jwtExpiresAt(token: string, now = Date.now()): number {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
    ) as { exp?: unknown };
    if (typeof payload.exp === 'number') return payload.exp * 1000;
  } catch {
    // not a readable JWT — fall through to the default
  }
  return now + 5 * 60_000;
}
