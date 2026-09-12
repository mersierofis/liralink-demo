import { Prisma } from '../generated/prisma/client';

export const LINK_INCLUDE = {
  merchant: { select: { businessName: true } },
  payment: true,
} as const;

export type LinkWithRelations = Prisma.PaymentLinkGetPayload<{
  include: typeof LINK_INCLUDE;
}>;
