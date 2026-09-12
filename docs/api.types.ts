// Generated from backend/src/**/dto/*.ts — see docs/00-PROJECT.md §5 for the domain
// model. Every type below is returned by a live endpoint (Settlement/Withdrawal/Balance
// went live with phase 2 part D).

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
  // Soroban invoice, created best-effort by POST /links (retry: POST /links/:id/onchain); null if not on-chain.
  // While set, quotedUSDC is locked until expiresAt (quoteExpiresAt === expiresAt) and never re-quoted.
  onchain: {
    contractId: string;
    invoiceCode: string;
    deadlineLedger: number;
    txHash?: string;
  } | null;
  createdAt: string;
}

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
    // present when the link is on-chain (normally from creation) — pay with invoice.pay(invoiceCode, payer) (see 00-PROJECT.md §7)
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

/** One row of GET /payments — every transfer, newest first. `settlement` is null for
 * installments that didn't complete their link (only the completing payment settles).
 * `link.status` / `receivedUSDC` are the link's CURRENT values (not as of this transfer): a
 * partial payment shows `status: 'underpaid'` with `receivedUSDC` < `quotedUSDC`. */
export interface PaymentListItem extends Payment {
  link: Pick<
    PaymentLink,
    'code' | 'title' | 'amountTRY' | 'status' | 'quotedUSDC' | 'receivedUSDC'
  >;
  settlement: Settlement | null;
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
