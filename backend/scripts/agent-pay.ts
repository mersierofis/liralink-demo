/**
 * agent-pay.ts — pay a LiraLink payment link end-to-end as an "agent", over x402.
 *
 * Usage:
 *   AGENT_SECRET=$(stellar keys secret payer) npm run agent:pay -- --code <LINKCODE> [--api <base>] [--max <usd>]
 *
 * --api defaults to http://localhost:3000/api. --max is the x402 client's per-payment spend cap in
 * USD, default 50; @x402/core's own default is $1, which rejects anything larger before signing.
 *
 * The payer needs testnet USDC and a USDC trustline, but no XLM: it signs Soroban auth entries
 * only; the x402.org facilitator builds, pays for and submits the transaction (testnet only).
 *
 * Steps: GET /pay/:code/agent → 402 with payment requirements → @x402/fetch signs and retries with
 * a PAYMENT-SIGNATURE header → 200 with the receipt → poll /pay/:code/status until paid.
 *
 * The secret key is read from the environment only, never from argv, and never logged.
 */
import { decodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { createEd25519Signer } from '@x402/stellar';
import { ExactStellarScheme } from '@x402/stellar/exact/client';

const NETWORK = 'stellar:testnet';
const DEFAULT_MAX_USD = 50;
const STATUS_POLL_ATTEMPTS = 30;
const STATUS_POLL_DELAY_MS = 2_000;

function parseArgs(argv: string[]): { code: string; api: string; max: number } {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) {
      throw new Error(`Unexpected argument: ${argv[i]}`);
    }
    out[argv[i].slice(2)] = argv[i + 1];
  }
  if (!out.code) {
    throw new Error(
      'Usage: AGENT_SECRET=S... npm run agent:pay -- --code <LINKCODE> [--api <base>] [--max <usd>]',
    );
  }
  const max = Number(out.max ?? DEFAULT_MAX_USD);
  if (!Number.isFinite(max) || max <= 0) {
    throw new Error(`--max must be a positive number of USD, got: ${out.max}`);
  }
  return {
    code: out.code.toUpperCase(),
    api: (out.api ?? 'http://localhost:3000/api').replace(/\/$/, ''),
    max,
  };
}

async function main(): Promise<void> {
  const { code, api, max } = parseArgs(process.argv.slice(2));
  const secret = process.env.AGENT_SECRET ?? '';
  if (!/^S[A-Z2-7]{55}$/.test(secret)) {
    throw new Error('AGENT_SECRET is not set to a Stellar secret key (S...)');
  }
  const url = `${api}/pay/${code}/agent`;

  // 1. What the server asks for (the paying fetch below does this again on its own).
  const first = await fetch(url);
  if (first.status !== 402) {
    throw new Error(
      `Expected 402 from ${url}, got ${first.status}: ${await first.text()}`,
    );
  }
  const required = (await first.json()) as PaymentRequired;
  const req = required.accepts[0];
  console.log(`402 Payment Required — ${required.resource.description}`);
  console.log(
    `  ${req.scheme} on ${req.network}: ${req.amount} base units of ${req.asset} → ${req.payTo} (timeout ${req.maxTimeoutSeconds}s, ${JSON.stringify(req.extra)})`,
  );

  // 2. Pay: sign the SAC transfer auth entries and retry with PAYMENT-SIGNATURE.
  const signer = createEd25519Signer(secret, NETWORK);
  console.log(`Paying as ${signer.address} (cap $${max} per payment) …`);
  const payingFetch = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: NETWORK, client: new ExactStellarScheme(signer) }],
    spendControls: { maxAmountPerPayment: max },
  });
  const started = Date.now();
  const paid = await payingFetch(url);
  const body = await paid.text();
  console.log(`${paid.status} after ${Date.now() - started} ms`);
  if (paid.status === 202) {
    // The facilitator timed out settling; the backend reconciles it — wait on the link status.
    console.log(`Settlement pending: ${body}`);
  } else if (paid.status !== 200) {
    throw new Error(`Payment was not accepted: ${body}`);
  } else {
    console.log(JSON.stringify(JSON.parse(body), null, 2));
  }
  const header = paid.headers.get('PAYMENT-RESPONSE');
  if (header) {
    const settle = decodePaymentResponseHeader(header);
    console.log(
      `PAYMENT-RESPONSE: tx ${settle.transaction} (${settle.network})`,
    );
  }

  // 3. The merchant side: link status as pay-web would poll it.
  for (let i = 0; i < STATUS_POLL_ATTEMPTS; i++) {
    const status = (await (
      await fetch(`${api}/pay/${code}/status`)
    ).json()) as {
      status: string;
      receivedUSDC: string;
    };
    if (status.status === 'paid') {
      console.log(
        `Link ${code} is paid (${status.receivedUSDC} USDC received)`,
      );
      return;
    }
    await new Promise((r) => setTimeout(r, STATUS_POLL_DELAY_MS));
  }
  throw new Error(`Link ${code} did not reach "paid"`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
