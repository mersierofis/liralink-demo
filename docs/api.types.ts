// Generated from backend/src/**/dto/*.ts — see docs/00-PROJECT.md §5 for the domain
// model. Settlement/Withdrawal/Balance are Phase 2 stubs: the tables exist but no
// endpoints return them yet — kept here so both frontends can type against the
// eventual shape without a second contract update.

export type LinkStatus = 'open' | 'underpaid' | 'paid' | 'expired' | 'cancelled';
export type PayRail = 'contract' | 'memo';
export type SettleStatus = 'pending' | 'processing' | 'completed' | 'failed';
export type WdStatus = 'requested' | 'processing' | 'completed' | 'failed';

export interface Merchant {
  id: string;
  email: string;
  businessName: string;
  iban?: string;
  autoSavePercent: number;
  // Excess USDC from overpaid links, parked here rather than auto-converted to
  // TRY — visible to the merchant, handled manually (refund or credit, Phase 3).
  unallocatedUSDC: string; // decimal string, 7 dp
  createdAt: string;
}

export interface Payment {
  id: string;
  linkId: string;
  rail: PayRail; // 'memo' = classic payment with text memo; 'contract' = paid through the Soroban invoice contract
  txHash: string;
  payerAddress: string;
  amountUSDC: string; // decimal string, 7 dp — the amount of *this* transaction, not the link total
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
  amountTRY: string; // decimal string, 2 dp — locked at creation; settlement always credits this, never receivedUSDC * fxRate
  quotedUSDC: string; // decimal string, 7 dp — locked at creation
  fxRate: string; // TRY per 1 USDC at quote time, 7 dp
  quoteExpiresAt: string;
  status: LinkStatus;
  expiresAt: string;
  payUrl: string;
  receivedUSDC: string; // decimal string, 7 dp — cumulative USDC matched so far ("0" until first payment)
  shortfallUSDC?: string; // decimal string, 7 dp — set only while status is 'underpaid'
  payment?: Payment; // most recent transfer (the completing one once paid) — convenience alias for payments.at(-1)
  payments: Payment[]; // every successful transfer that credited this link — partial installments AND the completing payment; ordered oldest→newest
  // set once POST /links/:id/onchain recorded it on the Soroban invoice contract; quotedUSDC is then locked until expiresAt
  contract?: { contractId: string; invoiceCode: string; deadlineLedger: number; txHash?: string };
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
  unallocatedUSDC: string;
}

/** What GET /pay/:code returns — the payer page's whole data model. */
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
  receivedUSDC: string;
  shortfallUSDC?: string;
  rails: {
    // present only after the merchant called POST /links/:id/onchain — pay with invoice.pay(invoiceCode, payer) (see 00-PROJECT.md §7)
    contract?: { contractId: string; invoiceCode: string };
    // always present — classic payment with a text memo
    memo?: { destination: string; memo: string };
  };
  asset: { code: string; issuer: string };
  network: 'testnet';
  payment?: Payment; // most recent transfer (completing one once paid) — alias for payments.at(-1)
  payments: Payment[]; // all transfers that credited this link, oldest→newest
}

/** What GET /pay/:code/status returns — polled every 2s by the payer page. */
export interface PayStatus {
  status: LinkStatus;
  receivedUSDC: string;
  shortfallUSDC?: string;
  payment?: Payment; // most recent transfer (completing one once paid) — alias for payments.at(-1)
  payments: Payment[]; // all transfers that credited this link, oldest→newest
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
