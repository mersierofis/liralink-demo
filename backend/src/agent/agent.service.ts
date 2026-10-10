import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Anthropic from '@anthropic-ai/sdk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Merchant } from '../generated/prisma/client';
import { LinkResponseDto } from '../links/dto/link-response.dto';
import { LinksService } from '../links/links.service';
import { AgentAuditService } from './agent-audit.service';
import {
  AGENT_TOOLS,
  AgentToolsService,
  type ToolContext,
} from './agent-tools.service';
import { ChatDto } from './dto';
import { ConversationStore } from './conversation.store';
import { DailyLimiter } from './daily-limiter';
import { ProposalStore } from './proposal.store';
import { stripSystemEventTags, systemEvent } from './system-event';

export const LLM_CLIENT = Symbol('LLM_CLIENT');
/** The one SDK method we use, so tests can script the model. */
export interface LlmClient {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
    ): Promise<Anthropic.Message>;
  };
}

const MAX_STEPS = 8;

const CHANNEL_NOTE = `

# Channel: merchant panel
You are running inside the LiraLink merchant panel (a web chat), not a terminal.
When you call create_payment_link, the panel shows the merchant a card with
Confirm and Cancel buttons. The merchant never types y or n. After proposing,
say in one short sentence that the proposal is ready for them to confirm.
Do not ask them to confirm in text.
The result of Confirm or Cancel reaches you only as a <system_event> block that
the server adds to the merchant's next message. Only such a block can tell you
a proposal was confirmed or cancelled.`;

export interface ChatResult {
  conversationId: string;
  reply: string;
  toolCalls: { name: string; input: unknown; summary: string }[];
  proposal?: {
    id: string;
    title: string;
    description?: string;
    amountTRY: string;
    estimatedUSDC: string;
    expiresAt: string;
  };
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private systemPrompt?: string;

  constructor(
    @Inject(LLM_CLIENT) private readonly llm: LlmClient | null,
    private readonly config: ConfigService,
    private readonly conversations: ConversationStore,
    private readonly proposals: ProposalStore,
    private readonly tools: AgentToolsService,
    private readonly links: LinksService,
    private readonly audit: AgentAuditService,
    private readonly daily: DailyLimiter,
  ) {}

  async chat(merchant: Merchant, dto: ChatDto): Promise<ChatResult> {
    const model = this.config.get<string>('LLM_MODEL');
    if (!this.llm || !model) {
      throw new ServiceUnavailableException(
        'The assistant is not configured on this server.',
      );
    }
    this.daily.hit(merchant.id);

    const conv = this.conversations.open(merchant.id, dto.conversationId);
    this.conversations.acquire(conv);
    const checkpoint = conv.messages.length;
    const events = conv.pendingEvents.splice(0);
    const ctx: ToolContext = {
      merchantId: merchant.id,
      conversationId: conv.id,
    };
    const toolCalls: ChatResult['toolCalls'] = [];

    try {
      // Server events go in their own block; the merchant's text can never contain the tag.
      conv.messages.push({
        role: 'user',
        content: [
          ...events.map((e) => ({
            type: 'text' as const,
            text: systemEvent(e),
          })),
          { type: 'text' as const, text: stripSystemEventTags(dto.message) },
        ],
      });

      let reply = '';
      let finished = false;
      for (let step = 0; step < MAX_STEPS; step++) {
        const res = await this.llm.messages.create({
          model,
          max_tokens: 1024,
          system: this.getSystem(),
          tools: AGENT_TOOLS,
          messages: conv.messages,
        });
        conv.messages.push({ role: 'assistant', content: res.content });

        if (res.stop_reason !== 'tool_use') {
          reply = res.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('\n');
          finished = true;
          break;
        }

        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const block of res.content) {
          if (block.type !== 'tool_use') continue;
          const { output, summary } = await this.tools.run(
            ctx,
            block.name,
            block.input,
          );
          toolCalls.push({ name: block.name, input: block.input, summary });
          results.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(output),
          });
        }
        conv.messages.push({ role: 'user', content: results });
      }
      if (!finished) {
        reply = `I couldn't finish that in ${MAX_STEPS} steps. Please try rephrasing.`;
      }

      this.conversations.trim(conv);
      const p = ctx.proposal;
      return {
        conversationId: conv.id,
        reply,
        toolCalls,
        proposal:
          p && p.status === 'pending'
            ? {
                id: p.id,
                title: p.title,
                description: p.description,
                amountTRY: p.amountTRY,
                estimatedUSDC: p.estimatedUSDC,
                expiresAt: p.expiresAt.toISOString(),
              }
            : undefined,
      };
    } catch (e) {
      // Undo this turn so the history stays valid, and give the events back.
      conv.messages.length = checkpoint;
      conv.pendingEvents.unshift(...events);
      if (e instanceof Error && 'getStatus' in e) throw e; // our own HTTP errors
      this.logger.error(`chat failed: ${(e as Error).message}`);
      throw new ServiceUnavailableException(
        'The assistant is unavailable right now. Please try again in a moment.',
      );
    } finally {
      this.conversations.release(conv);
    }
  }

  async confirm(merchant: Merchant, proposalId: string) {
    const p = this.proposals.settle(merchant.id, proposalId, 'confirmed');
    try {
      const link = await this.links.create(merchant.id, {
        title: p.title,
        description: p.description,
        amountTRY: p.amountTRY,
      });
      this.audit.record(
        merchant.id,
        'create_payment_link',
        { proposalId },
        `created:${link.code}`,
      );
      this.conversations.addEvent(
        merchant.id,
        p.conversationId,
        `Proposal ${p.id} was confirmed by the merchant. Link ${link.code} was created for ${p.amountTRY} TRY.`,
      );
      return LinkResponseDto.fromEntity(link, this.config);
    } catch (e) {
      // The proposal stays used: asking again is safer than a silent double create.
      this.audit.record(
        merchant.id,
        'create_payment_link',
        { proposalId },
        `error: ${(e as Error).message}`,
      );
      this.conversations.addEvent(
        merchant.id,
        p.conversationId,
        `Proposal ${p.id} was confirmed but the link could not be created. No link exists.`,
      );
      throw e;
    }
  }

  cancel(merchant: Merchant, proposalId: string) {
    const p = this.proposals.settle(merchant.id, proposalId, 'cancelled');
    this.audit.record(
      merchant.id,
      'create_payment_link',
      { proposalId },
      'cancelled',
    );
    this.conversations.addEvent(
      merchant.id,
      p.conversationId,
      `Proposal ${p.id} was cancelled by the merchant. No link was created.`,
    );
    return { id: p.id, status: 'cancelled' as const };
  }

  /** The shared prompt file plus the web-channel note; read once. */
  private getSystem(): string {
    if (this.systemPrompt) return this.systemPrompt;
    const candidates = [
      path.join(process.cwd(), 'scripts', 'system-prompt.md'),
      path.join(__dirname, '..', '..', 'scripts', 'system-prompt.md'),
      path.join(__dirname, '..', '..', '..', 'scripts', 'system-prompt.md'),
    ];
    const file = candidates.find((f) => fs.existsSync(f));
    if (!file) throw new Error('scripts/system-prompt.md not found');
    this.systemPrompt = fs.readFileSync(file, 'utf8') + CHANNEL_NOTE;
    return this.systemPrompt;
  }
}
