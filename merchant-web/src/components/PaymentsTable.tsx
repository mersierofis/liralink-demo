import { Link } from 'react-router-dom'

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { SettlementStatusBadge } from '@/components/SettlementStatusBadge'
import { ExplorerLink } from '@/components/ExplorerLink'
import { formatTRY, formatUSDC } from '@/lib/money'
import { formatDateTime, formatTime } from '@/lib/format'
import { findCompletingPayment } from '@/lib/payments'
import type { PaymentListItem, SettlementMode } from '@/api/types'

function FoldedIn({ completingPayment }: { completingPayment: PaymentListItem | undefined }) {
  const detail = completingPayment
    ? `Folded into the ${formatDateTime(completingPayment.detectedAt)} payment, which completed this link`
    : 'Partial payment towards this link — settled together with the payment that completed it'
  return (
    <span className="text-sm italic text-muted-foreground" title={detail}>
      {completingPayment ? `→ ${formatTime(completingPayment.detectedAt)}` : 'folded in'}
    </span>
  )
}

/** netTRY/feeUSDC are null until a settlement completes (they arrive together — see
 * 04-BACKEND-HANDOFF.md §2). Distinct from `settlement === null` (an installment, handled
 * by FoldedIn above): here a settlement exists but hasn't finished yet. */
function CreditedAmount({ payment, completingPayment }: { payment: PaymentListItem; completingPayment: PaymentListItem | undefined }) {
  if (!payment.settlement) return <FoldedIn completingPayment={completingPayment} />
  if (payment.settlement.netTRY === null) return <span className="text-sm text-muted-foreground">—</span>
  const fee = Number(payment.settlement.feeUSDC)
  return (
    <span title={fee > 0 ? `Anchor fee: ${formatUSDC(payment.settlement.feeUSDC!)}` : undefined}>
      {formatTRY(payment.settlement.netTRY)}
    </span>
  )
}

export function PaymentsTable({ payments, settlementMode }: { payments: PaymentListItem[]; settlementMode?: SettlementMode }) {
  const isAutoPayout = settlementMode === 'auto_payout'
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          <TableHead>Link</TableHead>
          <TableHead>USDC received</TableHead>
          <TableHead>FX rate</TableHead>
          <TableHead>{isAutoPayout ? 'Paid to IBAN' : 'TRY credited'}</TableHead>
          <TableHead>Settlement</TableHead>
          <TableHead className="text-right">Tx</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {payments.map((payment) => {
          const completingPayment = findCompletingPayment(payments, payment)
          return (
            <TableRow key={payment.id}>
              <TableCell className="text-sm text-muted-foreground">{formatDateTime(payment.detectedAt)}</TableCell>
              <TableCell>
                <Link to={`/links/${payment.linkId}`} className="hover:underline">
                  {payment.link.title}
                </Link>
                <p className="font-mono text-xs text-muted-foreground">{payment.link.code}</p>
              </TableCell>
              <TableCell>{formatUSDC(payment.amountUSDC)}</TableCell>
              <TableCell>
                {payment.settlement ? Number(payment.settlement.fxRate).toFixed(2) : <FoldedIn completingPayment={completingPayment} />}
              </TableCell>
              <TableCell>
                <CreditedAmount payment={payment} completingPayment={completingPayment} />
              </TableCell>
              <TableCell>
                <SettlementStatusBadge status={payment.settlement?.status ?? null} completingPayment={completingPayment} />
              </TableCell>
              <TableCell className="text-right">
                <ExplorerLink href={payment.explorerUrl}>View</ExplorerLink>
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
