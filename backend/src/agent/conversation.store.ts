import { ConflictException, Injectable } from '@nestjs/common';
import type Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';

export const CONVERSATION_TTL_MS = 30 * 60_000;
export const MAX_MESSAGES = 40;
export const MAX_CONVERSATIONS_PER_MERCHANT = 20;

export type ChatMessage = Anthropic.MessageParam;

export interface Conversation {
  id: string;
  merchantId: string;
  messages: ChatMessage[];
  /** Server-generated facts (confirm/cancel) delivered with the next user turn. */
  pendingEvents: string[];
  busy: boolean;
  touchedAt: number;
}

const isTurnStart = (m: ChatMessage): boolean =>
  m.role === 'user' &&
  (typeof m.content === 'string' ||
    (Array.isArray(m.content) && m.content.every((b) => b.type === 'text')));

@Injectable()
export class ConversationStore {
  private readonly conversations = new Map<string, Conversation>();

  private key(merchantId: string, id: string): string {
    return `${merchantId}:${id}`;
  }

  /** An unknown, expired or foreign id starts a fresh conversation under a new id. */
  open(merchantId: string, id?: string): Conversation {
    this.sweep();
    if (id) {
      const found = this.conversations.get(this.key(merchantId, id));
      if (found) {
        found.touchedAt = Date.now();
        return found;
      }
    }
    this.evictOldest(merchantId);
    const conv: Conversation = {
      id: randomUUID(),
      merchantId,
      messages: [],
      pendingEvents: [],
      busy: false,
      touchedAt: Date.now(),
    };
    this.conversations.set(this.key(merchantId, conv.id), conv);
    return conv;
  }

  /** One request at a time per conversation keeps the message order valid. */
  acquire(conv: Conversation): void {
    if (conv.busy) {
      throw new ConflictException(
        'The assistant is still answering. Please wait.',
      );
    }
    conv.busy = true;
  }

  release(conv: Conversation): void {
    conv.busy = false;
    conv.touchedAt = Date.now();
  }

  addEvent(merchantId: string, conversationId: string, text: string): void {
    const conv = this.conversations.get(this.key(merchantId, conversationId));
    if (conv) conv.pendingEvents.push(text);
  }

  /** Drops the oldest whole turns, never splitting a tool_use from its tool_result. */
  trim(conv: Conversation): void {
    while (conv.messages.length > MAX_MESSAGES) {
      const next = conv.messages.findIndex((m, i) => i > 0 && isTurnStart(m));
      if (next === -1) break;
      conv.messages.splice(0, next);
    }
  }

  private sweep(): void {
    const cutoff = Date.now() - CONVERSATION_TTL_MS;
    for (const [k, c] of this.conversations) {
      if (c.touchedAt < cutoff && !c.busy) this.conversations.delete(k);
    }
  }

  private evictOldest(merchantId: string): void {
    const mine = [...this.conversations.values()]
      .filter((c) => c.merchantId === merchantId && !c.busy)
      .sort((a, b) => a.touchedAt - b.touchedAt);
    while (mine.length >= MAX_CONVERSATIONS_PER_MERCHANT) {
      const oldest = mine.shift()!;
      this.conversations.delete(this.key(merchantId, oldest.id));
    }
  }
}
