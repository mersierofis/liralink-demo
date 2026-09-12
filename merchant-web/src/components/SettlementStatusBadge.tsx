import { Badge } from '@/components/ui/badge'
import type { SettleStatus } from '@/api/types'

const CONFIG: Record<SettleStatus, { label: string; variant: 'success' | 'warning' | 'secondary' | 'destructive' }> = {
  pending: { label: 'Pending', variant: 'secondary' },
  processing: { label: 'Processing', variant: 'warning' },
  completed: { label: 'Completed', variant: 'success' },
  failed: { label: 'Failed', variant: 'destructive' },
}

/**
 * `status` is null for an installment payment that didn't complete its link — only the
 * payment that flips the link to `paid` gets settled with the link's full amountTRY (see
 * 04-BACKEND-HANDOFF.md gotcha #5). Label it instead of showing a bare dash so it doesn't
 * read as missing data.
 */
export function SettlementStatusBadge({ status }: { status: SettleStatus | null }) {
  if (!status) {
    return (
      <Badge variant="outline" title="Partial payment towards this link — settled together with the payment that completed it">
        Partial payment
      </Badge>
    )
  }
  const { label, variant } = CONFIG[status]
  return <Badge variant={variant}>{label}</Badge>
}
