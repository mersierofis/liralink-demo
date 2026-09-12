// Imported BEFORE AppModule (ConfigModule snapshots process.env on import): sep24 provider, so the
// app runs in settlementMode 'auto_payout'. No test KYC URL and no contract — this spec never
// reaches the anchor (settlements are inserted directly).
const OVERRIDES = {
  ANCHOR_PROVIDER: 'sep24',
  ANCHOR_HOME_DOMAIN: 'testanchor.stellar.org',
  ANCHOR_SEP24_TEST_KYC_URL: '',
  INVOICE_CONTRACT_ID: '',
};

const saved: Record<string, string | undefined> = {};
for (const [k, v] of Object.entries(OVERRIDES)) {
  saved[k] = process.env[k];
  process.env[k] = v;
}

export function restoreEnv(): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
