import { Link } from 'react-router-dom'

import { SettlementStatusBadge } from '@/components/SettlementStatusBadge'
import { formatTRY, formatUSDC } from '@/lib/money'
import { formatDateTime } from '@/lib/format'
import type { PaymentListItem } from '@/api/types'

export function RecentPayments({ payments }: { payments: PaymentListItem[] }) {
  return (
    <ul className="divide-y">
      {payments.map((payment) => (
        <li key={payment.id} className="flex items-center justify-between gap-4 py-3">
          <div className="min-w-0">
            <Link to={`/links/${payment.linkId}`} className="font-medium hover:underline">
              {payment.link.title}
            </Link>
            <p className="text-xs text-muted-foreground">{formatDateTime(payment.detectedAt)}</p>
          </div>
          <div className="flex items-center gap-3 whitespace-nowrap">
            <span className="text-sm text-muted-foreground">{formatUSDC(payment.amountUSDC)}</span>
            <span className="text-sm font-medium">
              {payment.settlement ? (
                formatTRY(payment.settlement.amountTRY)
              ) : (
                <span
                  className="italic text-muted-foreground"
                  title="Partial payment towards this link — settled together with the payment that completed it"
                >
                  folded in
                </span>
              )}
            </span>
            <SettlementStatusBadge status={payment.settlement?.status ?? null} />
          </div>
        </li>
      ))}
    </ul>
  )
}
