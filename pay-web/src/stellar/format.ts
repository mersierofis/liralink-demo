export function shortAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 1) return address
  return `${address.slice(0, chars)}…${address.slice(-chars)}`
}

/** Display USDC with 2 dp; keep the original string for tooltips / tx amounts. */
export function formatUSDCDisplay(amount: string): string {
  const [whole, frac = ''] = amount.split('.')
  const padded = (frac + '00').slice(0, 2)
  return `${whole}.${padded}`
}

export function formatTRY(amount: string): string {
  const n = Number(amount)
  if (!Number.isFinite(n)) return `${amount} TRY`
  return new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' }).format(n)
}

export function formatFxRate(rate: string): string {
  const [whole, frac = ''] = rate.split('.')
  const trimmed = frac.replace(/0+$/, '').slice(0, 2)
  return trimmed ? `${whole}.${trimmed}` : whole
}
