import { Badge } from '@/components/ui/badge'
import { formatDateTime, formatTime } from '@/lib/format'
import type { PaymentListItem, SettleStatus } from '@/api/types'

const CONFIG: Record<SettleStatus, { label: string; variant: 'success' | 'warning' | 'secondary' | 'destructive' }> = {
  pending: { label: 'Pending', variant: 'secondary' },
  processing: { label: 'Processing', variant: 'warning' },
  completed: { label: 'Completed', variant: 'success' },
  failed: { label: 'Failed', variant: 'destructive' },
}

/**
 * `status` is null for an installment payment that didn't complete its link — only the
 * payment that flips the link to `paid` gets settled with the link's full amountTRY (see
 * 04-BACKEND-HANDOFF.md gotcha #5). Label it instead of showing a bare dash, and point at
 * the specific payment it was folded into when it's known (`completingPayment`).
 */
export function SettlementStatusBadge({
  status,
  completingPayment,
}: {
  status: SettleStatus | null
  completingPayment?: PaymentListItem
}) {
  if (!status) {
    const detail = completingPayment
      ? `Folded into the ${formatDateTime(completingPayment.detectedAt)} payment, which completed this link`
      : 'Partial payment towards this link — settled together with the payment that completed it'
    return (
      <Badge variant="outline" title={detail}>
        {completingPayment ? `→ ${formatTime(completingPayment.detectedAt)} payment` : 'Partial payment'}
      </Badge>
    )
  }
  const { label, variant } = CONFIG[status]
  return <Badge variant={variant}>{label}</Badge>
}
