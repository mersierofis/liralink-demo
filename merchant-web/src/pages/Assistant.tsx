import { useEffect, useRef, useState } from 'react'
import { Send, Sparkles } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ErrorState } from '@/components/ErrorState'
import { LinkCreatedDialog } from '@/components/LinkCreatedDialog'
import { ProposalCard, type ProposalUiState } from '@/components/ProposalCard'
import { ToolCallChips } from '@/components/ToolCallChips'
import { HttpError } from '@/api/client'
import { useAgentChat, useCancelProposal, useConfirmProposal } from '@/api/hooks'
import { cn } from '@/lib/utils'
import type { AgentProposal, AgentToolCall, PaymentLink } from '@/api/types'

interface Message {
  id: number
  role: 'user' | 'assistant'
  text: string
  toolCalls?: AgentToolCall[]
  proposal?: AgentProposal
}

const SUGGESTIONS = ['Kim ödemedi?', '5000 TRY kaç USDC?', 'Create a 200 TRY link']

function friendlyError(e: unknown): string {
  if (e instanceof HttpError) {
    if (e.statusCode === 429) return e.message // the server's message says which limit and when it resets
    if (e.statusCode === 503) return 'The assistant is not available right now. Please try again in a moment.'
    if (e.statusCode === 409) return 'The assistant is still answering the last message. Please wait a moment.'
    return e.message
  }
  return 'Could not reach the assistant. Check your connection and try again.'
}

export default function AssistantPage() {
  const [messages, setMessages] = useState<Message[]>([])
  const [conversationId, setConversationId] = useState<string | undefined>()
  const [input, setInput] = useState('')
  const [lastText, setLastText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [proposalStates, setProposalStates] = useState<Record<string, ProposalUiState>>({})
  const [createdLink, setCreatedLink] = useState<PaymentLink | null>(null)
  const nextId = useRef(1)
  const bottomRef = useRef<HTMLDivElement>(null)

  const chat = useAgentChat()
  const confirm = useConfirmProposal()
  const cancel = useCancelProposal()

  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ behavior: 'smooth' })
  }, [messages, chat.isPending])

  const setProposalState = (id: string, state: ProposalUiState) =>
    setProposalStates((prev) => ({ ...prev, [id]: state }))

  const send = (text: string) => {
    const message = text.trim()
    if (!message || chat.isPending) return
    setError(null)
    setLastText(message)
    setMessages((prev) => [...prev, { id: nextId.current++, role: 'user', text: message }])
    setInput('')
    chat.mutate(
      { conversationId, message },
      {
        onSuccess: (res) => {
          setConversationId(res.conversationId)
          setMessages((prev) => [
            ...prev,
            { id: nextId.current++, role: 'assistant', text: res.reply, toolCalls: res.toolCalls, proposal: res.proposal },
          ])
        },
        onError: (e) => setError(friendlyError(e)),
      },
    )
  }

  const retry = () => {
    // The failed turn is rolled back on the server, so re-sending the same text is safe.
    setMessages((prev) => (prev.at(-1)?.role === 'user' ? prev.slice(0, -1) : prev))
    send(lastText)
  }

  const onConfirm = (proposal: AgentProposal) => {
    setProposalState(proposal.id, { status: 'confirming' })
    confirm.mutate(proposal.id, {
      onSuccess: (link) => {
        setProposalState(proposal.id, { status: 'confirmed', link })
        setCreatedLink(link)
      },
      onError: (e) => setProposalState(proposal.id, { status: 'failed', message: friendlyError(e) }),
    })
  }

  const onCancel = (proposal: AgentProposal) => {
    setProposalState(proposal.id, { status: 'cancelling' })
    cancel.mutate(proposal.id, {
      onSuccess: () => setProposalState(proposal.id, { status: 'cancelled' }),
      onError: (e) => setProposalState(proposal.id, { status: 'failed', message: friendlyError(e) }),
    })
  }

  const newChat = () => {
    setMessages([])
    setConversationId(undefined)
    setError(null)
    setInput('')
    setProposalStates({})
  }

  return (
    <div className="flex h-[calc(100vh-9rem)] flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Sparkles className="h-5 w-5" />
          Assistant
        </h1>
        <Button variant="outline" size="sm" onClick={newChat} disabled={chat.isPending}>
          New chat
        </Button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto rounded-lg border bg-background p-4" aria-live="polite">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <p className="font-medium">Ask about your payment links, or have a new one drafted.</p>
            <p className="max-w-md text-sm text-muted-foreground">
              The assistant can check rates and link statuses, and propose a payment link. Nothing is created until
              you press Confirm.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <Button key={s} variant="outline" size="sm" onClick={() => send(s)}>
                  {s}
                </Button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={cn('flex flex-col gap-2', m.role === 'user' ? 'items-end' : 'items-start')}>
            {m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0 && (
              <div className="w-full max-w-md">
                <ToolCallChips calls={m.toolCalls} />
              </div>
            )}
            <div
              className={cn(
                'max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm',
                m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground',
              )}
            >
              {m.text}
            </div>
            {m.proposal && (
              <ProposalCard
                proposal={m.proposal}
                state={proposalStates[m.proposal.id] ?? { status: 'pending' }}
                onConfirm={() => onConfirm(m.proposal!)}
                onCancel={() => onCancel(m.proposal!)}
                onShowLink={setCreatedLink}
              />
            )}
          </div>
        ))}

        {chat.isPending && (
          <div className="flex items-start">
            <div className="rounded-lg bg-secondary px-3 py-2 text-sm text-muted-foreground" role="status">
              Thinking…
            </div>
          </div>
        )}
        {error && <ErrorState message={error} onRetry={retry} />}
        <div ref={bottomRef} />
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          send(input)
        }}
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about your links, or say “Create a 200 TRY link”"
          maxLength={2000}
          aria-label="Message"
          disabled={chat.isPending}
        />
        <Button type="submit" disabled={chat.isPending || !input.trim()} className="gap-1.5">
          <Send className="h-4 w-4" />
          Send
        </Button>
      </form>

      <LinkCreatedDialog link={createdLink} onOpenChange={(open) => !open && setCreatedLink(null)} />
    </div>
  )
}
