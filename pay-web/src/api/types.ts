// Generated from backend/src/**/dto/*.ts — see docs/00-PROJECT.md §5 for the domain
// model. Every type below is returned by a live endpoint (Settlement/Withdrawal/Balance
// went live with phase 2 part D).

export type LinkStatus = 'open' | 'underpaid' | 'paid' | 'expired' | 'cancelled';
export type PayRail = 'contract' | 'memo' | 'x402';
export type SettleStatus = 'pending' | 'processing' | 'completed' | 'failed';
export type WdStatus = 'requested' | 'processing' | 'completed' | 'failed';
// POST /usdc-withdrawals: 'submitted' until the payment is on the ledger.
export type UsdcWdStatus = 'submitted' | 'completed' | 'failed';
export type UsdcWdSource = 'saved' | 'unallocated';
// Why a USDC withdrawal is 'failed' — terminal, the amount went back to its source balance:
// failed_on_ledger: the transaction landed but failed; expired_unsubmitted: it never landed in time.
export type UsdcWdFailReason = 'failed_on_ledger' | 'expired_unsubmitted';
// 'balance': TRY accrues in availableTRY and the merchant withdraws (mock anchor).
// 'auto_payout': the anchor pays the IBAN during settlement; POST /withdrawals → 409 (sep24 anchor).
export type SettlementMode = 'balance' | 'auto_payout';
// Why a settlement is 'failed' — terminal, never retried:
// unexpected_fee_asset: the anchor reported its fee in an asset other than our USDC;
// invalid_fee: fee < 0 or > amountUSDC; anchor_status: the anchor ended the transaction as
// error/expired/refunded/…; amount_mismatch: the anchor expected another amount (nothing sent).
export type SettleFailReason =
  | 'unexpected_fee_asset'
  | 'invalid_fee'
  | 'anchor_status'
  | 'amount_mismatch';

export interface Merchant {
  id: string;
  email: string;
  businessName: string;
  iban?: string;
  autoSavePercent: number;
  // Excess USDC from overpaid links + stray payments, parked here rather than auto-converted to
  // TRY. The merchant can send it to their own wallet (POST /usdc-withdrawals, source 'unallocated').
  unallocatedUSDC: string; // decimal string, 7 dp
  settlementMode: SettlementMode; // 'auto_payout' → hide Withdraw, show "Paid to IBAN" + paidOutTRY
  createdAt: string;
}

export interface Payment {
  id: string;
  linkId: string;
  rail: PayRail; // 'memo' = classic payment with text memo; 'contract' = paid through the Soroban invoice contract; 'x402' = agent paid GET /pay/:code/agent (testnet)
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
  feeUSDC: string | null; // 7 dp — anchor fee; null until completed (mock: "0.0000000")
  netTRY: string | null; // 2 dp — TRY credited (balance) or paid to the IBAN (auto_payout); null until completed
  provider: 'mock' | 'sep24';
  status: SettleStatus;
  anchorRef?: string;
  failReason: SettleFailReason | null; // set only when status is 'failed'
  // sep24 at a real anchor: the anchor's KYC / bank-details page, waiting for the merchant — show a
  // "Complete verification" button. Non-null only while status is 'processing' and the anchor waits;
  // the settlement resumes by itself once the form is done. Treat a missing field as null.
  interactiveUrl: string | null;
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

/** One row of GET /usdc-withdrawals (and the 201 of POST) — USDC sent from the platform account to
 * the merchant's own Stellar wallet. The amount leaves `source` immediately; a 'failed' row gave it back. */
export interface UsdcWithdrawal {
  id: string;
  merchantId: string;
  amountUSDC: string; // decimal string, 7 dp
  destination: string; // G… address
  source: UsdcWdSource;
  status: UsdcWdStatus;
  txHash: string; // known from the first response (signed before submitting)
  explorerUrl: string;
  failReason: UsdcWdFailReason | null; // set only when status is 'failed'
  createdAt: string;
  completedAt?: string;
}

export interface Balance {
  availableTRY: string;
  pendingTRY: string;
  savedUSDC: string; // 7 dp — net of non-failed USDC withdrawals from 'saved'
  unallocatedUSDC: string; // 7 dp — net of non-failed USDC withdrawals from 'unallocated'
  paidOutTRY: string; // 2 dp — Σ netTRY of completed auto_payout settlements (already on the IBAN)
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

/** One row of GET /unallocated — every credit to Merchant.unallocatedUSDC, newest first. The rows
 * of all pages sum to the credits; unallocatedUSDC = that sum − non-failed USDC withdrawals from
 * 'unallocated' (GET /usdc-withdrawals). 'stray': a payment to a link that was no longer payable
 * (paid/expired/cancelled), credited in full; 'overpaid': the excess over quotedUSDC on the
 * payment that completed a link. */
export interface UnallocatedCredit {
  id: string;
  source: 'stray' | 'overpaid';
  txHash: string;
  explorerUrl: string;
  amountUSDC: string; // decimal string, 7 dp — what this row added to unallocatedUSDC
  linkCode: string;
  reason: string; // e.g. 'link status is "paid"' · 'received 3.0000000 of 2.0000000 USDC quoted'
  createdAt: string;
}

/** GET /unallocated `summary` — over ALL pages, not the current one. remainingUSDC = creditedUSDC −
 * withdrawnUSDC and equals Balance.unallocatedUSDC; show the three next to the balance card. */
export interface UnallocatedSummary {
  creditedUSDC: string; // 7 dp — Σ amountUSDC of every UnallocatedCredit
  withdrawnUSDC: string; // 7 dp — Σ non-failed USDC withdrawals with source 'unallocated'
  remainingUSDC: string; // 7 dp — creditedUSDC − withdrawnUSDC
}

// ---- Paginated list envelopes, as returned by GET /links, /payments, /unallocated, /usdc-withdrawals ----
export interface Paginated<T> {
  items: T[];
  total: number;
}

/** What GET /unallocated returns. */
export interface UnallocatedList extends Paginated<UnallocatedCredit> {
  summary: UnallocatedSummary;
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
  settlementMode: SettlementMode;
}

export interface FxResponse {
  pair: 'USDC/TRY';
  rate: string;
  source: 'mock' | 'live';
  fetchedAt: string;
}
