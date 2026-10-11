import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Anthropic from '@anthropic-ai/sdk';
import { Decimal } from '../common/decimal';
import { FxService } from '../fx/fx.service';
import { LinksService } from '../links/links.service';
import { AgentAuditService } from './agent-audit.service';
import { ProposalStore, type Proposal } from './proposal.store';

export const LINK_STATUSES = [
  'open',
  'underpaid',
  'paid',
  'expired',
  'cancelled',
] as const; // must match ListLinksQueryDto
const MIN_LINK_TRY = 1;

export const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_fx_quote',
    description:
      "Convert an amount in Turkish lira (TRY) to USDC at LiraLink's current rate. Only TRY is supported.",
    input_schema: {
      type: 'object',
      properties: { amountTRY: { type: 'number' } },
      required: ['amountTRY'],
    },
  },
  {
    name: 'get_payment_link',
    description:
      "Get one of the merchant's payment links by its code (e.g. S7473UAW): status (open, underpaid, paid, expired, cancelled), amounts, and which rail detected each payment.",
    input_schema: {
      type: 'object',
      properties: { code: { type: 'string' } },
      required: ['code'],
    },
  },
  {
    name: 'list_payment_links',
    description:
      "List the merchant's payment links, optionally filtered by status. Use for questions like 'who hasn't paid'.",
    input_schema: {
      type: 'object',
      properties: { status: { type: 'string', enum: [...LINK_STATUSES] } },
    },
  },
  {
    name: 'create_payment_link',
    description:
      'PROPOSE a new TRY payment link. This does not create anything: the merchant sees a card with Confirm and Cancel buttons. Only say a link exists if a tool result or a <system_event> gives its code.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        amountTRY: { type: 'number' },
        description: { type: 'string' },
      },
      required: ['title', 'amountTRY'],
    },
  },
];

export interface ToolContext {
  merchantId: string;
  conversationId: string;
  /** The proposal created during this turn, if any (the latest wins). */
  proposal?: Proposal;
}

export interface ToolResult {
  output: Record<string, unknown>;
  summary: string;
}

const fail = (message: string): ToolResult => ({
  output: { error: message },
  summary: message,
});

@Injectable()
export class AgentToolsService {
  private readonly logger = new Logger(AgentToolsService.name);

  constructor(
    private readonly links: LinksService,
    private readonly fx: FxService,
    private readonly proposals: ProposalStore,
    private readonly audit: AgentAuditService,
    private readonly config: ConfigService,
  ) {}

  async run(
    ctx: ToolContext,
    name: string,
    rawInput: unknown,
  ): Promise<ToolResult> {
    const input = (
      rawInput && typeof rawInput === 'object' ? rawInput : {}
    ) as Record<string, unknown>;
    let result: ToolResult;
    try {
      switch (name) {
        case 'get_fx_quote':
          result = await this.getFxQuote(input);
          break;
        case 'get_payment_link':
          result = await this.getPaymentLink(ctx, input);
          break;
        case 'list_payment_links':
          result = await this.listPaymentLinks(ctx, input);
          break;
        case 'create_payment_link':
          result = await this.createPaymentLink(ctx, input);
          break;
        default:
          result = fail(`Unknown tool: ${name}`);
      }
    } catch (e) {
      this.logger.error(`tool ${name} failed: ${(e as Error).message}`);
      result = fail('That lookup failed. Please try again in a moment.');
    }
    const outcome =
      typeof result.output.proposalId === 'string'
        ? `proposed:${result.output.proposalId}`
        : typeof result.output.error === 'string'
          ? `error: ${result.output.error}`
          : 'ok';
    this.audit.record(ctx.merchantId, name, input, outcome);
    return result;
  }

  private async getFxQuote(
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const amount = Number(input.amountTRY);
    if (!Number.isFinite(amount) || amount <= 0) {
      return fail('amountTRY must be greater than 0.');
    }
    const { rate, source, fetchedAt } = await this.fx.getRate();
    const usdc = new Decimal(amount).dividedBy(rate).toFixed(2);
    return {
      output: {
        amountTRY: amount,
        rate: rate.toFixed(2),
        usdc,
        source,
        fetchedAt: fetchedAt.toISOString(),
      },
      summary: `${amount} TRY ≈ ${usdc} USDC (rate ${rate.toFixed(2)}, ${source})`,
    };
  }

  private async getPaymentLink(
    ctx: ToolContext,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const code =
      typeof input.code === 'string' ? input.code.trim().toUpperCase() : '';
    if (!code) return fail('code is required.');
    try {
      const link = await this.links.findOneByCodeForMerchant(
        ctx.merchantId,
        code,
      );
      return {
        output: {
          code: link.code,
          title: link.title,
          description: link.description ?? undefined,
          status: link.status,
          amountTRY: link.amountTRY.toFixed(2),
          quotedUSDC: link.quotedUSDC.toFixed(7),
          receivedUSDC: link.receivedUSDC.toFixed(7),
          shortfallUSDC: link.shortfallUSDC?.toFixed(7),
          expiresAt: link.expiresAt.toISOString(),
          payments: link.payments.map((p) => ({
            rail: p.rail,
            amountUSDC: p.amountUSDC.toFixed(7),
            txHash: p.txHash,
            detectedAt: p.detectedAt.toISOString(),
          })),
        },
        summary: `${link.code}: ${link.status}, ${link.amountTRY.toFixed(2)} TRY`,
      };
    } catch (e) {
      if (e instanceof NotFoundException) {
        return fail('Link not found for this merchant.');
      }
      throw e;
    }
  }

  private async listPaymentLinks(
    ctx: ToolContext,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const status = LINK_STATUSES.find((s) => s === input.status);
    if (input.status !== undefined && !status) {
      return fail(`status must be one of: ${LINK_STATUSES.join(', ')}.`);
    }
    const { items, total } = await this.links.findAll(ctx.merchantId, {
      status,
      page: 1,
      limit: 50,
    });
    return {
      output: {
        total,
        shown: items.length,
        items: items.map((l) => ({
          code: l.code,
          title: l.title,
          description: l.description ?? undefined,
          status: l.status,
          amountTRY: l.amountTRY.toFixed(2),
          receivedUSDC: l.receivedUSDC.toFixed(7),
          expiresAt: l.expiresAt.toISOString(),
        })),
      },
      summary: `${total} link${total === 1 ? '' : 's'}${status ? ` with status ${status}` : ''}`,
    };
  }

  /** Proposes only. The link exists after the merchant presses Confirm, never before. */
  private async createPaymentLink(
    ctx: ToolContext,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    const amount = Number(input.amountTRY);
    const max = this.config.get<number>('AGENT_MAX_LINK_TRY') ?? 340;
    if (!title) return fail('title is required.');
    if (!Number.isFinite(amount) || amount < MIN_LINK_TRY) {
      return fail(`amountTRY must be at least ${MIN_LINK_TRY}.00.`);
    }
    if (amount > max) {
      return fail(
        `Over the assistant limit: links created here may not exceed ${max} TRY. Nothing was proposed. The merchant can create larger links on the Links page.`,
      );
    }
    const amountTRY = new Decimal(amount).toFixed(2);
    const { rate } = await this.fx.getRate();
    const estimatedUSDC = new Decimal(amountTRY).dividedBy(rate).toFixed(2);
    const description =
      typeof input.description === 'string' && input.description.trim()
        ? input.description.trim().slice(0, 500)
        : undefined;
    const proposal = this.proposals.create({
      merchantId: ctx.merchantId,
      conversationId: ctx.conversationId,
      title: title.slice(0, 200),
      description,
      amountTRY,
      estimatedUSDC,
    });
    ctx.proposal = proposal;
    return {
      output: {
        proposalId: proposal.id,
        status: 'waiting for the merchant to press Confirm or Cancel',
        title: proposal.title,
        amountTRY,
        estimatedUSDC,
        expiresAt: proposal.expiresAt.toISOString(),
        note: 'No link exists yet. Do not claim one was created.',
      },
      summary: `Proposal: "${proposal.title}", ${amountTRY} TRY (waiting for your confirmation)`,
    };
  }
}
