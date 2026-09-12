import type { PaymentListItem } from '@/api/types'

/**
 * For an installment payment (settlement: null — it didn't complete its link), find the
 * payment in the same page of results that did complete the link and carries the
 * settlement. Used to label "folded into <that payment>" instead of a bare dash — see
 * 04-BACKEND-HANDOFF.md gotcha #5. Returns undefined if the completing payment isn't in
 * the current page (falls back to a generic label at the call site).
 */
export function findCompletingPayment(payments: PaymentListItem[], payment: PaymentListItem): PaymentListItem | undefined {
  if (payment.settlement) return undefined
  return payments.find((p) => p.linkId === payment.linkId && p.settlement)
}
