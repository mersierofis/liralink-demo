import {
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

export const PROPOSAL_TTL_MS = 10 * 60_000;

export type ProposalStatus =
  'pending' | 'confirmed' | 'cancelled' | 'superseded' | 'expired';

export interface Proposal {
  id: string;
  merchantId: string;
  conversationId: string;
  title: string;
  description?: string;
  amountTRY: string; // 2 dp
  estimatedUSDC: string; // 2 dp
  expiresAt: Date;
  status: ProposalStatus;
}

/**
 * In-memory proposals: the only thing the model can create. A proposal becomes a link only when
 * the merchant calls take() through the confirm endpoint — single use, owner-bound, 10 minutes.
 */
@Injectable()
export class ProposalStore {
  private readonly proposals = new Map<string, Proposal>();

  create(input: Omit<Proposal, 'id' | 'expiresAt' | 'status'>): Proposal {
    this.sweep();
    // A new proposal replaces any still-pending one of the same conversation.
    for (const p of this.proposals.values()) {
      if (
        p.status === 'pending' &&
        p.merchantId === input.merchantId &&
        p.conversationId === input.conversationId
      ) {
        p.status = 'superseded';
      }
    }
    const proposal: Proposal = {
      ...input,
      id: randomUUID(),
      expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
      status: 'pending',
    };
    this.proposals.set(proposal.id, proposal);
    return proposal;
  }

  /**
   * Marks a pending proposal as confirmed or cancelled, synchronously, so two concurrent calls
   * can never both win. Another merchant's proposal is indistinguishable from an unknown one.
   */
  settle(
    merchantId: string,
    id: string,
    to: 'confirmed' | 'cancelled',
  ): Proposal {
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.merchantId !== merchantId) {
      throw new NotFoundException('Proposal not found');
    }
    if (
      proposal.status === 'pending' &&
      Date.now() >= proposal.expiresAt.getTime()
    ) {
      proposal.status = 'expired';
    }
    if (proposal.status === 'expired') {
      throw new GoneException(
        'This proposal has expired. Ask the assistant again.',
      );
    }
    if (proposal.status !== 'pending') {
      throw new ConflictException(
        `This proposal was already ${proposal.status}.`,
      );
    }
    proposal.status = to;
    return proposal;
  }

  /** Drops proposals that are long dead, so the map cannot grow without bound. */
  private sweep(): void {
    const cutoff = Date.now() - 3 * PROPOSAL_TTL_MS;
    for (const [id, p] of this.proposals) {
      if (p.expiresAt.getTime() < cutoff) this.proposals.delete(id);
    }
  }
}
