import { Badge } from '@/components/ui/badge'
import { describeUnsettledPayment } from '@/lib/payments'
import type { PaymentListItem, SettleStatus } from '@/api/types'

const CONFIG: Record<SettleStatus, { label: string; variant: 'success' | 'warning' | 'secondary' | 'destructive' }> = {
  pending: { label: 'Pending', variant: 'secondary' },
  processing: { label: 'Processing', variant: 'warning' },
  completed: { label: 'Completed', variant: 'success' },
  failed: { label: 'Failed', variant: 'destructive' },
}

/**
 * `payment.settlement` is null for an installment that didn't complete its link
 * (04-BACKEND-HANDOFF.md gotcha #5) — labelled from the link's current status/totals via
 * describeUnsettledPayment, never guessed from other rows on the page.
 */
export function SettlementStatusBadge({ payment }: { payment: PaymentListItem }) {
  if (!payment.settlement) {
    const { label, detail } = describeUnsettledPayment(payment)
    return (
      <Badge variant="outline" title={detail}>
        {label}
      </Badge>
    )
  }
  const { status, failReason } = payment.settlement
  const { label, variant } = CONFIG[status]
  return (
    <Badge variant={variant} title={status === 'failed' && failReason ? `Reason: ${failReason}` : undefined}>
      {label}
    </Badge>
  )
}
