// Imported BEFORE AppModule (ConfigModule snapshots process.env on import): fast mock anchor,
// and no Soroban calls — this spec is about the TRY ledger, not the contract rail.
const OVERRIDES = { ANCHOR_MOCK_DELAY_MS: '50', INVOICE_CONTRACT_ID: '' };

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
