// Imported BEFORE AppModule (ConfigModule snapshots process.env on import). Live SEP-6 against
// tr-mock-anchor.fly.dev — sends real testnet USDC, so it only switches on with SEP6_E2E=1;
// otherwise nothing is overridden and the spec is skipped.
export const SEP6_E2E = process.env.SEP6_E2E === '1';

const OVERRIDES = {
  ANCHOR_PROVIDER: 'sep6',
  ANCHOR_HOME_DOMAIN: 'tr-mock-anchor.fly.dev',
  // The anchor enforces a 1 USDC minimum, so links must be priced at its own rate — at the mock
  // 34.00 a 50 TRY link would quote 1.47 USDC and settle against a ~48 TRY/USDC anchor.
  FX_PROVIDER: 'anchor',
  INVOICE_CONTRACT_ID: '',
};

const saved: Record<string, string | undefined> = {};
if (SEP6_E2E) {
  for (const [k, v] of Object.entries(OVERRIDES)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
}

export function restoreEnv(): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
