// Imported BEFORE AppModule (ConfigModule snapshots process.env on import). Live SEP-24 against
// testanchor.stellar.org WITHOUT the test-KYC shortcut: a person completes the interactive form in a
// browser, as at a real anchor. Sends 1 real testnet USDC, so it only switches on with
// SEP24_MANUAL_KYC=1; otherwise nothing is overridden and the spec is skipped.
export const SEP24_MANUAL_KYC = process.env.SEP24_MANUAL_KYC === '1';

const OVERRIDES = {
  ANCHOR_PROVIDER: 'sep24',
  ANCHOR_HOME_DOMAIN: 'testanchor.stellar.org',
  ANCHOR_SEP24_TEST_KYC_URL: '',
  INVOICE_CONTRACT_ID: '',
};

const saved: Record<string, string | undefined> = {};
if (SEP24_MANUAL_KYC) {
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
