// Imported BEFORE AppModule (ConfigModule snapshots process.env on import): a fake key/model so the
// assistant is "configured" (the LLM itself is replaced by a script), no Soroban calls, a small
// daily cap for the cap test, and an audit log in the OS temp dir instead of backend/.
import * as os from 'node:os';
import * as path from 'node:path';

const OVERRIDES = {
  ANTHROPIC_API_KEY: 'e2e-not-a-real-key',
  LLM_MODEL: 'e2e-model',
  AGENT_MAX_LINK_TRY: '340',
  AGENT_DAILY_LIMIT: '12',
  AGENT_AUDIT_LOG: path.join(
    os.tmpdir(),
    `liralink-agent-audit-e2e-${process.pid}.log`,
  ),
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
