// Imported BEFORE AppModule: ConfigModule.forRoot snapshots process.env when AppModule is
// first loaded. Contract configured, RPC unreachable — on-chain creation must fail softly.
export const ONCHAIN_ENV_OVERRIDES = {
  INVOICE_CONTRACT_ID:
    'CDKZYQI4HI347ZVAMXT2XPHLYDSDKN6ERELKASGJDII6AQU6ROFQ45EJ',
  // https so the SDK accepts it (it refuses plain http); nothing listens on port 9.
  RPC_URL: 'https://127.0.0.1:9',
};

export const savedEnv: Record<string, string | undefined> = {};

for (const [k, v] of Object.entries(ONCHAIN_ENV_OVERRIDES)) {
  savedEnv[k] = process.env[k];
  process.env[k] = v;
}

export function restoreEnv(): void {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
