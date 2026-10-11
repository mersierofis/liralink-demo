import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProposalCard } from './ProposalCard'
import type { AgentProposal, PaymentLink } from '@/api/types'

const NOW = new Date('2026-10-11T12:00:00Z')
const proposal: AgentProposal = {
  id: 'p1',
  title: 'Logo design',
  amountTRY: '200.00',
  estimatedUSDC: '5.88',
  expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
}

describe('ProposalCard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => vi.useRealTimers())

  it('shows title, amount, estimated USDC and a countdown', () => {
    render(<ProposalCard proposal={proposal} state={{ status: 'pending' }} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText('Logo design')).toBeInTheDocument()
    expect(screen.getByText(/200,00/)).toBeInTheDocument()
    expect(screen.getByText(/5\.88 USDC/)).toBeInTheDocument()
    expect(screen.getByText('Expires in 10:00')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(65_000)
    })
    expect(screen.getByText('Expires in 8:55')).toBeInTheDocument()
  })

  it('calls onConfirm and onCancel', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<ProposalCard proposal={proposal} state={{ status: 'pending' }} onConfirm={onConfirm} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('disables both buttons while a request is pending', () => {
    render(<ProposalCard proposal={proposal} state={{ status: 'confirming' }} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  })

  it('replaces the buttons with an expired message once the countdown ends', () => {
    render(<ProposalCard proposal={proposal} state={{ status: 'pending' }} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    act(() => {
      vi.advanceTimersByTime(10 * 60_000 + 1000)
    })
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()
    expect(screen.getByText(/Expired/)).toBeInTheDocument()
  })

  it('shows the created link code after confirm, and a cancelled note after cancel', () => {
    const link = { code: 'ABCD1234' } as PaymentLink
    const { rerender } = render(
      <ProposalCard proposal={proposal} state={{ status: 'confirmed', link }} onConfirm={vi.fn()} onCancel={vi.fn()} onShowLink={vi.fn()} />,
    )
    expect(screen.getByText('Link ABCD1234 created')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()
    rerender(<ProposalCard proposal={proposal} state={{ status: 'cancelled' }} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText(/No link was created/)).toBeInTheDocument()
  })

  it('shows a server error in place of the buttons', () => {
    render(
      <ProposalCard proposal={proposal} state={{ status: 'failed', message: 'This proposal has expired.' }} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('This proposal has expired.')
  })
})
