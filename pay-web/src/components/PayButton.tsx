import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatUSDCDisplay } from '@/stellar/format'

/**
 * Primary action is the classic memo rail.
 * Contract rail can be plugged in later as the primary path when ready for demo.
 */
export function PayButton({
  amountUSDC,
  disabled,
  loading,
  hasContractRail,
  onPayMemo,
}: {
  amountUSDC: string
  disabled?: boolean
  loading?: boolean
  /** Kept for call-site compatibility; contract rail UI is hidden until demo-ready. */
  hasContractRail?: boolean
  onPayMemo: () => void
}) {
  void hasContractRail
  return (
    <Button
      type="button"
      className="w-full"
      size="lg"
      disabled={disabled || loading}
      onClick={onPayMemo}
    >
      {loading ? <Loader2 className="animate-spin" /> : null}
      {loading ? 'Signing…' : `Pay ${formatUSDCDisplay(amountUSDC)} USDC`}
    </Button>
  )
}
