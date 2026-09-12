// Single source of truth for money math. Always import Decimal from here, never
// from a standalone `decimal.js` — Prisma's re-export is a distinct instance and
// `instanceof`/mixed-operand checks against a separate decimal.js silently misbehave.
export { Prisma as PrismaNamespace } from '../generated/prisma/client';
import { Prisma } from '../generated/prisma/client';

export const Decimal = Prisma.Decimal;
export type Decimal = Prisma.Decimal;
