import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(1),
  CORS_ORIGINS: z.string().min(1),
  PAY_WEB_BASE_URL: z.string().url(),

  STELLAR_NETWORK: z.enum(['testnet', 'public']).default('testnet'),
  HORIZON_URL: z.string().url(),
  RPC_URL: z.string().url(),
  NETWORK_PASSPHRASE: z.string().min(1),
  PLATFORM_ACCOUNT_SECRET: z.string().min(1),
  USDC_CODE: z.string().min(1),
  USDC_ISSUER: z.string().min(1),
  // Empty disables the contract rail (no rails.contract, no event polling).
  INVOICE_CONTRACT_ID: z.string().optional().default(''),

  // `anchor`: the SEP-38 rate of ANCHOR_HOME_DOMAIN, so a link locks the rate the anchor will
  // actually settle at. Falls back to the mock rate when the quote call fails.
  FX_PROVIDER: z.enum(['mock', 'live', 'anchor']).default('mock'),
  FX_MOCK_RATE_TRY_PER_USDC: z.coerce.number().positive(),
  FX_LIVE_URL: z.string().optional().default(''),

  ANCHOR_PROVIDER: z.enum(['mock', 'sep24', 'sep6']).default('mock'),
  ANCHOR_HOME_DOMAIN: z.string().optional().default(''),
  // testanchor.stellar.org only: its reference server, where the interactive KYC form posts — the
  // backend fills that form in itself. Empty (real anchors): the merchant completes interactiveUrl.
  ANCHOR_SEP24_TEST_KYC_URL: z.string().optional().default(''),
  // Body format of the SEP-24 interactive withdraw for this anchor (never JSON). A rejected format
  // still gets one try in the other one.
  ANCHOR_SEP24_ENCODING: z
    .enum(['multipart', 'urlencoded'])
    .default('multipart'),
  ANCHOR_MOCK_DELAY_MS: z.coerce.number().int().nonnegative().default(3000),

  LINK_DEFAULT_EXPIRY_HOURS: z.coerce.number().positive().default(24),
  QUOTE_TTL_MINUTES: z.coerce.number().positive().default(10),

  // x402 rail (GET /pay/:code/agent). The x402.org facilitator serves stellar:testnet only; empty
  // (or STELLAR_NETWORK=public) disables the route with 503.
  X402_FACILITATOR_URL: z
    .string()
    .optional()
    .default('https://x402.org/facilitator'),

  // Merchant-panel assistant (POST /agent/chat). Empty key or model: /agent/chat answers 503 and
  // the rest of the app is unaffected. The key never leaves the backend.
  ANTHROPIC_API_KEY: z.string().optional().default(''),
  LLM_MODEL: z.string().optional().default(''),
  // Largest link the assistant may even propose (≈ 10 USDC at the mock rate of 34.00).
  AGENT_MAX_LINK_TRY: z.coerce.number().positive().default(340),
  // Per-merchant /agent/chat requests per UTC day (in memory, resets on restart).
  AGENT_DAILY_LIMIT: z.coerce.number().int().positive().default(200),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('\n  ');
    throw new Error(`Invalid environment configuration:\n  ${issues}`);
  }
  return result.data;
}
