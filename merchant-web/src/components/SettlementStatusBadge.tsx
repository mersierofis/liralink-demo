import { Badge } from '@/components/ui/badge'
import type { SettleStatus } from '@/api/types'

const CONFIG: Record<SettleStatus, { label: string; variant: 'success' | 'warning' | 'secondary' | 'destructive' }> = {
  pending: { label: 'Pending', variant: 'secondary' },
  processing: { label: 'Processing', variant: 'warning' },
  completed: { label: 'Completed', variant: 'success' },
  failed: { label: 'Failed', variant: 'destructive' },
}

export function SettlementStatusBadge({ status }: { status: SettleStatus | null }) {
  if (!status) return <span className="text-sm text-muted-foreground">—</span>
  const { label, variant } = CONFIG[status]
  return <Badge variant={variant}>{label}</Badge>
}
