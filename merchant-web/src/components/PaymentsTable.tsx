import { Link } from 'react-router-dom'

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { SettlementStatusBadge } from '@/components/SettlementStatusBadge'
import { ExplorerLink } from '@/components/ExplorerLink'
import { formatTRY, formatUSDC } from '@/lib/money'
import { formatDateTime } from '@/lib/format'
import type { PaymentListItem } from '@/api/types'

export function PaymentsTable({ payments }: { payments: PaymentListItem[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          <TableHead>Link</TableHead>
          <TableHead>USDC received</TableHead>
          <TableHead>FX rate</TableHead>
          <TableHead>TRY credited</TableHead>
          <TableHead>Settlement</TableHead>
          <TableHead className="text-right">Tx</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {payments.map((payment) => (
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
              {payment.settlement ? (
                Number(payment.settlement.fxRate).toFixed(2)
              ) : (
                <span
                  className="text-sm italic text-muted-foreground"
                  title="Partial payment towards this link — settled together with the payment that completed it"
                >
                  folded in
                </span>
              )}
            </TableCell>
            <TableCell>
              {payment.settlement ? (
                formatTRY(payment.settlement.amountTRY)
              ) : (
                <span
                  className="text-sm italic text-muted-foreground"
                  title="Partial payment towards this link — settled together with the payment that completed it"
                >
                  folded in
                </span>
              )}
            </TableCell>
            <TableCell>
              <SettlementStatusBadge status={payment.settlement?.status ?? null} />
            </TableCell>
            <TableCell className="text-right">
              <ExplorerLink href={payment.explorerUrl}>View</ExplorerLink>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
