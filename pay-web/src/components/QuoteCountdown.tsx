import { useEffect, useState } from 'react'

function remainingMs(iso: string): number {
  return Math.max(0, new Date(iso).getTime() - Date.now())
}

function formatCountdown(ms: number): string {
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function QuoteCountdown({ expiresAt }: { expiresAt: string }) {
  const [ms, setMs] = useState(() => remainingMs(expiresAt))

  useEffect(() => {
    setMs(remainingMs(expiresAt))
    const id = window.setInterval(() => setMs(remainingMs(expiresAt)), 1000)
    return () => window.clearInterval(id)
  }, [expiresAt])

  if (ms <= 0) {
    return <p className="text-xs text-muted-foreground">Quote expired — refresh the page for a new quote.</p>
  }

  return (
    <p className="text-xs text-muted-foreground">
      Quote refreshes in <span className="font-mono text-foreground">{formatCountdown(ms)}</span>
    </p>
  )
}
