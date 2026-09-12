import { Link } from 'react-router-dom'

import { SettlementStatusBadge } from '@/components/SettlementStatusBadge'
import { formatTRY, formatUSDC } from '@/lib/money'
import { formatDateTime, formatTime } from '@/lib/format'
import { findCompletingPayment } from '@/lib/payments'
import type { PaymentListItem } from '@/api/types'

export function RecentPayments({ payments }: { payments: PaymentListItem[] }) {
  return (
    <ul className="divide-y">
      {payments.map((payment) => {
        const completingPayment = findCompletingPayment(payments, payment)
        return (
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
                  payment.settlement.netTRY !== null ? (
                    formatTRY(payment.settlement.netTRY)
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )
                ) : (
                  <span
                    className="italic text-muted-foreground"
                    title={
                      completingPayment
                        ? `Folded into the ${formatDateTime(completingPayment.detectedAt)} payment, which completed this link`
                        : 'Partial payment towards this link — settled together with the payment that completed it'
                    }
                  >
                    {completingPayment ? `→ ${formatTime(completingPayment.detectedAt)}` : 'folded in'}
                  </span>
                )}
              </span>
              <SettlementStatusBadge status={payment.settlement?.status ?? null} completingPayment={completingPayment} />
            </div>
          </li>
        )
      })}
    </ul>
  )
}
