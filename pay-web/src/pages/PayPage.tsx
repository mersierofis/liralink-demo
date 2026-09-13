import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { AmountDisplay } from '@/components/AmountDisplay'
import { ErrorState } from '@/components/ErrorState'
import { MerchantHeader } from '@/components/MerchantHeader'
import { PaidReceipt } from '@/components/PaidReceipt'
import { PayButton } from '@/components/PayButton'
import { PayingState } from '@/components/PayingState'
import { WalletButton } from '@/components/WalletButton'
import { HttpError } from '@/api/client'
import { payAmountUSDC, usePayQuote, usePayStatus, useSubmitted } from '@/api/hooks'
import type { PayQuote } from '@/api/types'
import { buildPaymentXdr, loadUsdcBalance, submitSignedXdr } from '@/stellar/buildPayment'
import { useWallet } from '@/stellar/useWallet'

type UiPhase = 'quote' | 'paying' | 'paid'

function StatusBadge({ status }: { status: PayQuote['status'] }) {
  const map: Record<PayQuote['status'], { label: string; className: string }> = {
    open: { label: 'Open', className: 'bg-secondary text-secondary-foreground' },
    underpaid: { label: 'Underpaid', className: 'bg-warning text-warning-foreground' },
    paid: { label: 'Paid', className: 'bg-success text-success-foreground' },
    expired: { label: 'Expired', className: 'bg-muted text-muted-foreground' },
    cancelled: { label: 'Cancelled', className: 'bg-destructive text-destructive-foreground' },
  }
  const s = map[status]
  return <Badge className={s.className}>{s.label}</Badge>
}

export function PayPage() {
  const { code: rawCode } = useParams()
  const code = rawCode?.toUpperCase()
  const [searchParams] = useSearchParams()
  const mockPay = searchParams.get('mockpay') === '1'
  const queryClient = useQueryClient()

  const quoteQuery = usePayQuote(code)
  const wallet = useWallet()
  const submitted = useSubmitted(code)

  const [phase, setPhase] = useState<UiPhase>('quote')
  const [payError, setPayError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [pendingTxHash, setPendingTxHash] = useState<string | null>(null)
  const [balances, setBalances] = useState<{
    hasTrustline: boolean
    balance: string
    funded: boolean
  } | null>(null)

  const quote = quoteQuery.data
  const payable = quote?.status === 'open' || quote?.status === 'underpaid'
  const shouldPoll =
    phase === 'paying' || (payable && Boolean(pendingTxHash)) || quote?.status === 'underpaid'

  const statusQuery = usePayStatus(code, Boolean(code) && shouldPoll)

  const liveStatus = statusQuery.data?.status ?? quote?.status
  const mergedQuote: PayQuote | undefined = useMemo(() => {
    if (!quote) return undefined
    if (!statusQuery.data) return quote
    return {
      ...quote,
      status: statusQuery.data.status,
      receivedUSDC: statusQuery.data.receivedUSDC,
      shortfallUSDC: statusQuery.data.shortfallUSDC,
      payment: statusQuery.data.payment ?? quote.payment,
      payments: statusQuery.data.payments?.length ? statusQuery.data.payments : quote.payments,
    }
  }, [quote, statusQuery.data])

  useEffect(() => {
    if (liveStatus === 'paid') setPhase('paid')
  }, [liveStatus])

  useEffect(() => {
    if (!wallet.address || !quote) {
      setBalances(null)
      return
    }
    let cancelled = false
    void loadUsdcBalance(wallet.address, quote.asset).then((b) => {
      if (!cancelled) setBalances(b)
    })
    return () => {
      cancelled = true
    }
  }, [wallet.address, quote])

  async function runPay(opts?: { skipWallet?: boolean }) {
    if (!mergedQuote || !code) return
    setPayError(null)
    setSubmitting(true)
    try {
      if (opts?.skipWallet || mockPay) {
        const fakeHash = `mock${Date.now().toString(16).padStart(56, '0')}`.slice(0, 64)
        setPhase('paying')
        setPendingTxHash(fakeHash)
        void submitted.mutateAsync(fakeHash).catch(() => undefined)
        return
      }
      if (!wallet.address) {
        setPayError('Connect a wallet first.')
        return
      }
      const xdr = await buildPaymentXdr(mergedQuote, wallet.address)
      const signed = await wallet.signXdr(xdr)
      const { hash } = await submitSignedXdr(signed)
      console.info('[pay-web] submitted Stellar tx', hash)
      setPendingTxHash(hash)
      setPhase('paying')
      void submitted.mutateAsync(hash).catch(() => undefined)
      void queryClient.invalidateQueries({ queryKey: ['pay', code] })
    } catch (err) {
      setPhase('quote')
      setPayError(err instanceof Error ? err.message : 'Payment failed')
    } finally {
      setSubmitting(false)
    }
  }

  if (!code) {
    return (
      <Shell>
        <ErrorState title="No link" message="Open a payment link like /p/DEMO0001." />
      </Shell>
    )
  }

  if (quoteQuery.isLoading) {
    return (
      <Shell>
        <Card className="w-full max-w-[420px]">
          <CardContent className="space-y-4 p-6">
            <Skeleton className="mx-auto h-4 w-24" />
            <Skeleton className="mx-auto h-6 w-48" />
            <Skeleton className="mx-auto h-10 w-40" />
            <Skeleton className="h-11 w-full" />
          </CardContent>
        </Card>
      </Shell>
    )
  }

  if (quoteQuery.isError) {
    const notFound = quoteQuery.error instanceof HttpError && quoteQuery.error.statusCode === 404
    return (
      <Shell>
        <ErrorState
          title={notFound ? 'Link not found' : 'Could not load link'}
          message={
            notFound
              ? `No payment link with code ${code}.`
              : quoteQuery.error instanceof Error
                ? quoteQuery.error.message
                : 'Unknown error'
          }
          onRetry={() => void quoteQuery.refetch()}
        />
      </Shell>
    )
  }

  if (!mergedQuote) return null

  if (mergedQuote.status === 'expired' || mergedQuote.status === 'cancelled') {
    return (
      <Shell>
        <Card className="w-full max-w-[420px]">
          <CardHeader className="items-center gap-2">
            <StatusBadge status={mergedQuote.status} />
            <MerchantHeader
              merchantName={mergedQuote.merchantName}
              title={mergedQuote.title}
              description={mergedQuote.description}
            />
          </CardHeader>
          <CardContent>
            <ErrorState
              title={mergedQuote.status === 'expired' ? 'Link expired' : 'Link cancelled'}
              message={
                mergedQuote.status === 'expired'
                  ? 'Ask the merchant for a new payment link.'
                  : 'This payment link was cancelled by the merchant.'
              }
            />
          </CardContent>
        </Card>
      </Shell>
    )
  }

  if (mergedQuote.status === 'paid' || phase === 'paid') {
    return (
      <Shell>
        <Card className="w-full max-w-[420px]">
          <CardHeader className="items-center">
            <StatusBadge status="paid" />
          </CardHeader>
          <CardContent>
            <PaidReceipt quote={mergedQuote} payment={statusQuery.data?.payment} />
          </CardContent>
        </Card>
      </Shell>
    )
  }

  return (
    <Shell>
      <Card className="w-full max-w-[420px]">
        <CardHeader className="items-center gap-3 space-y-0">
          <StatusBadge status={mergedQuote.status} />
          <MerchantHeader
            merchantName={mergedQuote.merchantName}
            title={mergedQuote.title}
            description={mergedQuote.description}
          />
        </CardHeader>
        <CardContent className="space-y-5">
          <AmountDisplay quote={mergedQuote} />

          {phase === 'paying' ? (
            <PayingState />
          ) : (
            <>
              <WalletButton
                address={wallet.address}
                connecting={wallet.connecting}
                usdcBalance={balances?.balance}
                hasTrustline={balances?.hasTrustline}
                funded={balances?.funded}
                onConnect={() => void wallet.connect()}
                onDisconnect={wallet.disconnect}
              />
              {wallet.error ? <ErrorState title="Wallet" message={wallet.error} /> : null}
              {payError ? (
                <ErrorState title="Payment failed" message={payError} onRetry={() => void runPay()} />
              ) : null}
              <PayButton
                amountUSDC={payAmountUSDC(mergedQuote)}
                disabled={
                  mockPay
                    ? false
                    : !wallet.address ||
                      !balances?.funded ||
                      !balances.hasTrustline ||
                      submitting
                }
                loading={submitting}
                hasContractRail={Boolean(mergedQuote.rails.contract)}
                onPayMemo={() => void runPay({ skipWallet: mockPay })}
              />
              {mockPay ? (
                <p className="text-center text-[11px] text-muted-foreground">
                  Dev mode: ?mockpay=1 skips the wallet and hits /submitted with a fake hash.
                </p>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
    </Shell>
  )
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-gradient-to-b from-slate-50 to-slate-100 px-4 py-8">
      <div className="mx-auto mb-6 max-w-[420px] text-center">
        <p className="text-sm font-semibold tracking-tight text-slate-900">LiraLink</p>
        <p className="text-xs text-muted-foreground">Pay with USDC on Stellar</p>
      </div>
      <div className="mx-auto flex max-w-[420px] justify-center">{children}</div>
    </div>
  )
}
