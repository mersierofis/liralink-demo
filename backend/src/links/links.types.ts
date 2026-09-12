import { Prisma } from '../generated/prisma/client';

export const LINK_INCLUDE = {
  merchant: { select: { businessName: true } },
  payments: { orderBy: { detectedAt: 'asc' } },
} as const satisfies Prisma.PaymentLinkInclude;

export type LinkWithRelations = Prisma.PaymentLinkGetPayload<{
  include: typeof LINK_INCLUDE;
}>;
