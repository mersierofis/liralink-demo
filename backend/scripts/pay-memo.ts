/**
 * pay-memo.ts — send a classic USDC payment with a text memo on Stellar testnet.
 *
 * Usage:
 *   npm run pay:memo -- --secret <S...> --to <G...> --amount <usdc-decimal> --memo <text>
 *
 * The USDC asset (code + issuer) is read from backend/.env (USDC_CODE / USDC_ISSUER),
 * so it matches exactly what the backend listener matches against. Horizon URL and the
 * network passphrase also come from .env (testnet defaults if unset).
 *
 * The secret key is never logged. It is only used to derive the source account and sign.
 */
import * as path from 'path';
import * as dotenv from 'dotenv';
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Memo,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

// Load the backend .env regardless of the process cwd.
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

interface Args {
  secret: string;
  to: string;
  amount: string;
  memo: string;
}

function parseArgs(argv: string[]): Args {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    out[key] = value;
    i += 1;
  }

  const required = ['secret', 'to', 'amount', 'memo'] as const;
  const missing = required.filter((k) => !out[k]);
  if (missing.length) {
    throw new Error(
      `Missing required arg(s): ${missing.map((m) => `--${m}`).join(', ')}\n` +
        `Usage: npm run pay:memo -- --secret <S...> --to <G...> --amount <usdc-decimal> --memo <text>`,
    );
  }
  return { secret: out.secret, to: out.to, amount: out.amount, memo: out.memo };
}

function validate(args: Args): void {
  if (!/^S[A-Z2-7]{55}$/.test(args.secret)) {
    // Deliberately do NOT echo the value — only report the shape is wrong.
    throw new Error('--secret does not look like a valid Stellar secret key (S... , 56 chars)');
  }
  if (!/^G[A-Z2-7]{55}$/.test(args.to)) {
    throw new Error(`--to is not a valid Stellar public key: ${args.to}`);
  }
  if (!/^\d+(\.\d{1,7})?$/.test(args.amount)) {
    throw new Error(`--amount must be a decimal with ≤7 dp: ${args.amount}`);
  }
  if (Buffer.byteLength(args.memo, 'utf8') > 28) {
    throw new Error(`--memo must be ≤28 bytes for a text memo: "${args.memo}"`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  validate(args);

  const horizonUrl = process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org';
  const networkPassphrase =
    process.env.NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015';
  const usdcCode = process.env.USDC_CODE ?? 'USDC';
  const usdcIssuer = process.env.USDC_ISSUER;
  if (!usdcIssuer) {
    throw new Error('USDC_ISSUER is not set in backend/.env');
  }

  const server = new Horizon.Server(horizonUrl);
  const usdc = new Asset(usdcCode, usdcIssuer);

  const keypair = Keypair.fromSecret(args.secret);
  const source = keypair.publicKey();

  console.log(`Network:     ${networkPassphrase}`);
  console.log(`Horizon:     ${horizonUrl}`);
  console.log(`From:        ${source}`);
  console.log(`To:          ${args.to}`);
  console.log(`Asset:       ${usdcCode}:${usdcIssuer}`);
  console.log(`Amount:      ${args.amount} ${usdcCode}`);
  console.log(`Memo (text): "${args.memo}"`);

  const account = await server.loadAccount(source);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: args.to,
        asset: usdc,
        amount: args.amount,
      }),
    )
    .addMemo(Memo.text(args.memo))
    .setTimeout(60)
    .build();

  tx.sign(keypair);

  console.log('\nSubmitting…');
  const result = await server.submitTransaction(tx);

  console.log(`\n✅ Submitted`);
  console.log(`tx hash:  ${result.hash}`);
  console.log(`explorer: https://stellar.expert/explorer/testnet/tx/${result.hash}`);
}

main().catch((err: unknown) => {
  // Surface Horizon's result codes if present; never touch the secret.
  const resultCodes =
    (err as { response?: { data?: { extras?: { result_codes?: unknown } } } })
      ?.response?.data?.extras?.result_codes;
  if (resultCodes) {
    console.error('\n❌ Horizon rejected the transaction:');
    console.error(JSON.stringify(resultCodes, null, 2));
  } else {
    console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(1);
});
