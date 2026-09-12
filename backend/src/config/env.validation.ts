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

  FX_PROVIDER: z.enum(['mock', 'live']).default('mock'),
  FX_MOCK_RATE_TRY_PER_USDC: z.coerce.number().positive(),
  FX_LIVE_URL: z.string().optional().default(''),

  ANCHOR_PROVIDER: z.enum(['mock', 'sep24']).default('mock'),
  ANCHOR_HOME_DOMAIN: z.string().optional().default(''),
  // testanchor.stellar.org only: its reference server, where the interactive KYC form posts — the
  // backend fills that form in itself. Empty (real anchors): the merchant completes interactiveUrl.
  ANCHOR_SEP24_TEST_KYC_URL: z.string().optional().default(''),
  ANCHOR_MOCK_DELAY_MS: z.coerce.number().int().nonnegative().default(3000),

  LINK_DEFAULT_EXPIRY_HOURS: z.coerce.number().positive().default(24),
  QUOTE_TTL_MINUTES: z.coerce.number().positive().default(10),
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
