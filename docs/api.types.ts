// Generated from backend/src/**/dto/*.ts (Phase 1) — see docs/00-PROJECT.md §5 for the
// original domain model. Settlement/Withdrawal/Balance are Phase 2 stubs: the tables exist
// but no endpoints return them yet — kept here so both frontends can type against the
// eventual shape without a second contract update.

export type LinkStatus = 'open' | 'paid' | 'expired' | 'cancelled';
export type SettleStatus = 'pending' | 'processing' | 'completed' | 'failed';
export type WdStatus = 'requested' | 'processing' | 'completed' | 'failed';

export interface Merchant {
  id: string;
  email: string;
  businessName: string;
  iban?: string;
  autoSavePercent: number;
  createdAt: string;
}

export interface Payment {
  id: string;
  linkId: string;
  txHash: string;
  payerAddress: string;
  amountUSDC: string; // decimal string, 7 dp
  ledger: number;
  explorerUrl: string;
  detectedAt: string;
}

export interface PaymentLink {
  id: string;
  code: string; // 8-char, URL-safe, unique, uppercase — also the tx memo
  merchantId: string;
  merchantName: string;
  title: string;
  description?: string;
  amountTRY: string; // decimal string, 2 dp
  quotedUSDC: string; // decimal string, 7 dp
  fxRate: string; // TRY per 1 USDC at quote time, 7 dp
  quoteExpiresAt: string;
  status: LinkStatus;
  expiresAt: string;
  payUrl: string;
  payment?: Payment; // present when paid
  createdAt: string;
}

/** Phase 2 stub — no endpoint returns this yet. */
export interface Settlement {
  id: string;
  merchantId: string;
  paymentId: string;
  amountUSDC: string;
  amountTRY: string;
  fxRate: string;
  savedUSDC: string;
  provider: 'mock' | 'sep24';
  status: SettleStatus;
  anchorRef?: string;
  createdAt: string;
  completedAt?: string;
}

/** Phase 2 stub — no endpoint returns this yet. */
export interface Withdrawal {
  id: string;
  merchantId: string;
  amountTRY: string;
  iban: string;
  status: WdStatus;
  anchorRef?: string;
  createdAt: string;
  completedAt?: string;
}

/** Phase 2 stub — no endpoint returns this yet. */
export interface Balance {
  availableTRY: string;
  pendingTRY: string;
  savedUSDC: string;
}

/** What GET /pay/:code and GET /pay/:code/status return — the payer page's whole data model. */
export interface PayQuote {
  code: string;
  merchantName: string;
  title: string;
  description?: string;
  amountTRY: string;
  amountUSDC: string;
  fxRate: string;
  quoteExpiresAt: string;
  status: LinkStatus;
  expiresAt: string;
  destination: string; // platform collection account (G...)
  memo: string; // = code
  asset: { code: string; issuer: string };
  network: 'testnet';
  payment?: Payment;
}

export interface ApiError {
  statusCode: number;
  message: string;
  error?: string;
}

// ---- Paginated list envelopes, as returned by GET /links and GET /payments ----
export interface Paginated<T> {
  items: T[];
  total: number;
}

// ---- Auth ----
export interface AuthResult {
  token: string;
  merchant: Merchant;
}

// ---- Health / FX ----
export interface HealthResponse {
  ok: boolean;
  horizon: 'up' | 'down';
  anchor: 'mock' | 'sep24';
  listener: 'running' | 'stopped';
  platformAccount: string;
}

export interface FxResponse {
  pair: 'USDC/TRY';
  rate: string;
  source: 'mock' | 'live';
  fetchedAt: string;
}
