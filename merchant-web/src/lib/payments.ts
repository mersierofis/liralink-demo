import { formatUSDC } from './money'
import type { PaymentListItem } from '@/api/types'

export interface UnsettledPaymentInfo {
  label: string
  detail: string
}

/**
 * Only meaningful when `payment.settlement` is null (an installment that didn't itself
 * complete its link — 04-BACKEND-HANDOFF.md gotcha #5). Uses the link's CURRENT status and
 * totals (`payment.link.status`/`quotedUSDC`/`receivedUSDC`, added in PR #5) as the source of
 * truth — never infer this by searching other rows on the same page for a "completing"
 * payment, which silently gives the wrong answer whenever that payment isn't in the current
 * page of results, or (as caught in review) when the link is still `underpaid` and nothing
 * has completed it yet.
 *
 * NOTE: as of 2026-09-13 the live testnet backend hasn't redeployed PR #5 yet, so
 * `link.status`/`quotedUSDC`/`receivedUSDC` come back `undefined` in production even though
 * `docs/api.types.ts` (already merged) says they're required — a real contract drift, not
 * something to paper over. The fallback below keeps the UI from showing "undefined" until
 * the backend catches up; remove it once `GET /health` (or a real payment) confirms it has.
 */
export function describeUnsettledPayment(payment: PaymentListItem): UnsettledPaymentInfo {
  const { link } = payment
  if (!link.status) {
    return {
      label: 'Partial payment',
      detail: 'This transfer did not complete its link on its own — settled together with another payment.',
    }
  }
  if (link.status === 'underpaid') {
    return {
      label: `Partial — ${formatUSDC(link.receivedUSDC)} of ${formatUSDC(link.quotedUSDC)}`,
      detail: 'This link is still underpaid — awaiting the rest of the payment.',
    }
  }
  if (link.status === 'paid') {
    return {
      label: 'Earlier installment',
      detail: "A different payment completed this link and carries its settlement — see the link's page for the full history.",
    }
  }
  // open (shouldn't have a partial payment without going underpaid, but handled defensively),
  // expired, or cancelled: the link never completed, so this payment was never settled and
  // never will be.
  return {
    label: `Partial — link ${link.status}`,
    detail: `This link ${link.status} before it was fully paid, so this payment was never settled.`,
  }
}
