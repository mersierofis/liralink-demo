import { http, HttpResponse, type HttpHandler } from 'msw'

import { MOCK_TOKEN, computeBalance, seed, simulatePayment, state } from './data'
import type { AgentChatResponse, AgentProposal, ApiError, LinkStatus, PaymentLink, PaymentListItem, Withdrawal } from '@/api/types'

seed()

function error(status: number, message: string) {
  const body: ApiError = { statusCode: status, message }
  return HttpResponse.json(body, { status })
}

function requireAuth(request: Request) {
  const auth = request.headers.get('authorization')
  if (auth !== `Bearer ${MOCK_TOKEN}`) return error(401, 'Unauthorized')
  return null
}

// ---- Assistant mock: canned replies keyed on the message, in-memory proposals ----
const mockProposals = new Map<string, AgentProposal & { status: 'pending' | 'confirmed' | 'cancelled' }>()

function mockAgentReply(message: string): AgentChatResponse {
  const conversationId = 'mock-conversation'
  const lower = message.toLowerCase()
  const amount = message.match(/(\d+(?:[.,]\d+)?)\s*(?:try|tl)/i)?.[1]?.replace(',', '.')

  if (/link/.test(lower) && /create|oluştur|yarat|propose/.test(lower) && amount) {
    if (Number(amount) > 340) {
      return {
        conversationId,
        reply: 'Links made here are limited to 340 TRY. You can create larger links on the Links page.',
        toolCalls: [
          { name: 'create_payment_link', input: { title: 'Payment', amountTRY: Number(amount) }, summary: 'Over the assistant limit: 340 TRY' },
        ],
      }
    }
    const proposal = {
      id: `mock-proposal-${Math.random().toString(36).slice(2, 8)}`,
      title: 'Payment',
      amountTRY: Number(amount).toFixed(2),
      estimatedUSDC: (Number(amount) / 34).toFixed(2),
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    }
    mockProposals.set(proposal.id, { ...proposal, status: 'pending' })
    return {
      conversationId,
      reply: 'The proposal is ready for you to confirm.',
      toolCalls: [
        { name: 'create_payment_link', input: { title: proposal.title, amountTRY: Number(amount) }, summary: `Proposal: "Payment", ${proposal.amountTRY} TRY (waiting for your confirmation)` },
      ],
      proposal,
    }
  }
  if (/usdc|dolar/.test(lower) && amount) {
    const usdc = (Number(amount) / 34).toFixed(2)
    return {
      conversationId,
      reply: `${amount} TRY is about ${usdc} USDC at the current rate of 34.00 TRY per USDC (mock rate).`,
      toolCalls: [{ name: 'get_fx_quote', input: { amountTRY: Number(amount) }, summary: `${amount} TRY ≈ ${usdc} USDC (rate 34.00, mock)` }],
    }
  }
  if (/ödemedi|paid|unpaid/.test(lower)) {
    const open = state.links.filter((l) => l.status === 'open')
    return {
      conversationId,
      reply: open.length ? `You have ${open.length} open links that have not been paid yet.` : 'Every link is paid.',
      toolCalls: [{ name: 'list_payment_links', input: { status: 'open' }, summary: `${open.length} links with status open` }],
    }
  }
  return {
    conversationId,
    reply: 'I can convert TRY to USDC, check your payment links, and propose a new link for you to confirm.',
    toolCalls: [],
  }
}

export const handlers: HttpHandler[] = [
  http.post('*/api/agent/chat', async ({ request }) => {
    const authError = requireAuth(request)
    if (authError) return authError
    const body = (await request.json()) as { message: string }
    await new Promise((r) => setTimeout(r, 600))
    return HttpResponse.json(mockAgentReply(body.message))
  }),

  http.post('*/api/agent/proposals/:id/confirm', ({ request, params }) => {
    const authError = requireAuth(request)
    if (authError) return authError
    const p = mockProposals.get(String(params.id))
    if (!p) return error(404, 'Proposal not found')
    if (p.status !== 'pending') return error(409, `This proposal was already ${p.status}.`)
    if (Date.now() >= new Date(p.expiresAt).getTime()) return error(410, 'This proposal has expired. Ask the assistant again.')
    p.status = 'confirmed'
    const code = `MOCK${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    const link: PaymentLink = {
      id: `link-${code}`,
      code,
      merchantId: state.merchant.id,
      merchantName: state.merchant.businessName,
      title: p.title,
      amountTRY: p.amountTRY,
      quotedUSDC: (Math.ceil((Number(p.amountTRY) / 34) * 1e7) / 1e7).toFixed(7),
      fxRate: '34.0000000',
      quoteExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      status: 'open',
      expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
      payUrl: `http://localhost:5174/p/${code}`,
      receivedUSDC: '0',
      payments: [],
      onchain: null,
      createdAt: new Date().toISOString(),
    }
    state.links.unshift(link)
    return HttpResponse.json(link, { status: 201 })
  }),

  http.post('*/api/agent/proposals/:id/cancel', ({ request, params }) => {
    const authError = requireAuth(request)
    if (authError) return authError
    const p = mockProposals.get(String(params.id))
    if (!p) return error(404, 'Proposal not found')
    if (p.status !== 'pending') return error(409, `This proposal was already ${p.status}.`)
    p.status = 'cancelled'
    return HttpResponse.json({ id: p.id, status: 'cancelled' })
  }),

  http.post('*/api/auth/register', async ({ request }) => {
    const body = (await request.json()) as { email: string; businessName: string }
    state.merchant = { ...state.merchant, email: body.email, businessName: body.businessName }
    return HttpResponse.json({ token: MOCK_TOKEN, merchant: state.merchant }, { status: 201 })
  }),

  http.post('*/api/auth/login', async ({ request }) => {
    const body = (await request.json()) as { email: string; password: string }
    if (body.email !== state.merchant.email || body.password !== state.password) {
      return error(401, 'Invalid email or password')
    }
    return HttpResponse.json({ token: MOCK_TOKEN, merchant: state.merchant })
  }),

  http.get('*/api/me', ({ request }) => {
    const authError = requireAuth(request)
    if (authError) return authError
    return HttpResponse.json(state.merchant)
  }),

  http.patch('*/api/me', async ({ request }) => {
    const authError = requireAuth(request)
    if (authError) return authError
    const body = (await request.json()) as Partial<typeof state.merchant> & {
      currentPassword?: string
      newPassword?: string
    }
    if (body.currentPassword !== undefined || body.newPassword !== undefined) {
      if (!body.currentPassword || !body.newPassword) {
        return error(400, 'Both currentPassword and newPassword are required')
      }
      if (body.currentPassword !== state.password) {
        return error(403, 'Current password is incorrect')
      }
      state.password = body.newPassword
      return HttpResponse.json(state.merchant)
    }
    state.merchant = { ...state.merchant, ...body }
    return HttpResponse.json(state.merchant)
  }),

  http.get('*/api/links', ({ request }) => {
    const authError = requireAuth(request)
    if (authError) return authError
    const url = new URL(request.url)
    const status = url.searchParams.get('status') as LinkStatus | null
    const limit = Number(url.searchParams.get('limit') ?? '20')
    const items = state.links
      .filter((l) => !status || l.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
    return HttpResponse.json({ items, total: items.length })
  }),

  http.get('*/api/links/:id', ({ request, params }) => {
    const authError = requireAuth(request)
    if (authError) return authError
    const link = state.links.find((l) => l.id === params.id)
    if (!link) return error(404, 'Link not found')
    return HttpResponse.json(link)
  }),

  http.post('*/api/links', async ({ request }) => {
    const authError = requireAuth(request)
    if (authError) return authError
    const body = (await request.json()) as { title: string; description?: string; amountTRY: string; expiresInHours?: number }
    const code = `MOCK${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    const rate = 34
    const quotedUSDC = (Math.ceil((Number(body.amountTRY) / rate) * 1e7) / 1e7).toFixed(7)
    const hours = body.expiresInHours ?? 24
    const newLink: PaymentLink = {
      id: `link-${code}`,
      code,
      merchantId: state.merchant.id,
      merchantName: state.merchant.businessName,
      title: body.title,
      description: body.description,
      amountTRY: Number(body.amountTRY).toFixed(2),
      quotedUSDC,
      fxRate: '34.0000000',
      quoteExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      status: 'open',
      expiresAt: new Date(Date.now() + hours * 3_600_000).toISOString(),
      payUrl: `http://localhost:5174/p/${code}`,
      receivedUSDC: '0',
      payments: [],
      onchain: null,
      createdAt: new Date().toISOString(),
    }
    state.links.unshift(newLink)
    return HttpResponse.json(newLink, { status: 201 })
  }),

  http.post('*/api/links/:id/cancel', ({ request, params }) => {
    const authError = requireAuth(request)
    if (authError) return authError
    const link = state.links.find((l) => l.id === params.id)
    if (!link) return error(404, 'Link not found')
    if (link.status !== 'open') return error(409, 'Only open links can be cancelled')
    link.status = 'cancelled'
    return HttpResponse.json(link)
  }),

  // Mock-only dev toggle (03-MERCHANT-WEB.md): rehearse the Open -> Paid projector
  // transition without a real wallet. Not part of the real API contract.
  http.post('*/api/mock/pay/:id', ({ params }) => {
    simulatePayment(params.id as string)
    return HttpResponse.json({ accepted: true }, { status: 202 })
  }),

  http.get('*/api/balance', ({ request }) => {
    const authError = requireAuth(request)
    if (authError) return authError
    return HttpResponse.json(computeBalance())
  }),

  http.get('*/api/payments', ({ request }) => {
    const authError = requireAuth(request)
    if (authError) return authError
    const url = new URL(request.url)
    const limit = Number(url.searchParams.get('limit') ?? '20')
    const items: PaymentListItem[] = state.links
      .flatMap((link) =>
        link.payments.map((payment) => ({
          ...payment,
          link: {
            code: link.code,
            title: link.title,
            amountTRY: link.amountTRY,
            status: link.status,
            quotedUSDC: link.quotedUSDC,
            receivedUSDC: link.receivedUSDC,
          },
          settlement: state.settlements.find((s) => s.paymentId === payment.id) ?? null,
        })),
      )
      .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt))
      .slice(0, limit)
    return HttpResponse.json({ items, total: items.length })
  }),

  http.get('*/api/settlements', ({ request }) => {
    const authError = requireAuth(request)
    if (authError) return authError
    const url = new URL(request.url)
    const limit = Number(url.searchParams.get('limit') ?? '20')
    const items = [...state.settlements].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit)
    return HttpResponse.json({ items, total: items.length })
  }),

  // Mock merchant has no unallocated credits (unallocatedUSDC is "0.0000000"), so the list is empty.
  http.get('*/api/unallocated', ({ request }) => {
    const authError = requireAuth(request)
    if (authError) return authError
    const zero = '0.0000000'
    return HttpResponse.json({
      items: [],
      total: 0,
      summary: { creditedUSDC: zero, withdrawnUSDC: zero, remainingUSDC: zero },
    })
  }),

  http.get('*/api/withdrawals', ({ request }) => {
    const authError = requireAuth(request)
    if (authError) return authError
    const url = new URL(request.url)
    const limit = Number(url.searchParams.get('limit') ?? '20')
    const items = [...state.withdrawals].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit)
    return HttpResponse.json({ items, total: items.length })
  }),

  http.post('*/api/withdrawals', async ({ request }) => {
    const authError = requireAuth(request)
    if (authError) return authError
    if (state.merchant.settlementMode === 'auto_payout') {
      return error(409, 'Payouts are automatic in this mode')
    }
    const body = (await request.json()) as { amountTRY: string; iban?: string }
    const iban = body.iban ?? state.merchant.iban
    if (!iban) return error(400, 'No IBAN on file — set one in Settings or provide one here')
    const balance = computeBalance()
    if (Number(body.amountTRY) > Number(balance.availableTRY)) {
      return error(422, 'Amount exceeds available balance')
    }
    const withdrawal: Withdrawal = {
      id: `wd-${Date.now()}`,
      merchantId: state.merchant.id,
      amountTRY: Number(body.amountTRY).toFixed(2),
      iban,
      status: 'requested',
      createdAt: new Date().toISOString(),
    }
    state.withdrawals.unshift(withdrawal)
    setTimeout(() => {
      withdrawal.status = 'processing'
      setTimeout(() => {
        withdrawal.status = 'completed'
        withdrawal.completedAt = new Date().toISOString()
      }, 2500)
    }, 2500)
    return HttpResponse.json(withdrawal, { status: 201 })
  }),
]
