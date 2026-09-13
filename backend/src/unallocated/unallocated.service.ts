import { Injectable } from '@nestjs/common';
import { Paginated } from '../common/dto/pagination.dto';
import { Decimal } from '../common/decimal';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** stray: a payment to a link that was no longer payable (PaymentAttempt).
 * overpaid: the excess over quotedUSDC on the payment that completed a link. */
export type UnallocatedSource = 'stray' | 'overpaid';

export interface UnallocatedCredit {
  id: string; // PaymentAttempt id (stray) or Payment id (overpaid)
  source: UnallocatedSource;
  txHash: string;
  amountUSDC: Decimal;
  linkCode: string;
  reason: string;
  createdAt: Date;
}

interface CreditRow {
  id: string;
  source: UnallocatedSource;
  txHash: string;
  amountUSDC: string;
  linkCode: string;
  reason: string;
  createdAt: Date;
}

/**
 * Everything that credited `merchant.unallocatedUSDC`, so the rows sum to it. Derived, not stored:
 * strays are PaymentAttempt rows (reason `stray: …`, or the prefix-less `link status is …` of rows
 * recorded before the prefix existed); overpayments carry no attempt row — the excess is
 * `receivedUSDC − quotedUSDC` of a link, credited on its completing (latest) payment.
 */
@Injectable()
export class UnallocatedService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(
    merchantId: string,
    page: number,
    limit: number,
  ): Promise<Paginated<UnallocatedCredit>> {
    const credits = Prisma.sql`
      SELECT a.id, 'stray' AS source, a."txHash", a."amountUSDC"::text AS "amountUSDC",
             l.code AS "linkCode", regexp_replace(a.reason, '^stray: ', '') AS reason,
             a."createdAt"
        FROM "PaymentAttempt" a
        JOIN "PaymentLink" l ON l.code = a."linkCode"
       WHERE l."merchantId" = ${merchantId}
         AND (a.reason LIKE 'stray: %' OR a.reason LIKE 'link status is %')
      UNION ALL
      SELECT p.id, 'overpaid', p."txHash", (l."receivedUSDC" - l."quotedUSDC")::text, l.code,
             'received ' || l."receivedUSDC"::text || ' of ' || l."quotedUSDC"::text || ' USDC quoted',
             p."detectedAt"
        FROM "PaymentLink" l
        JOIN LATERAL (
          SELECT id, "txHash", "detectedAt" FROM "Payment"
           WHERE "linkId" = l.id ORDER BY "detectedAt" DESC LIMIT 1
        ) p ON true
       WHERE l."merchantId" = ${merchantId} AND l."receivedUSDC" > l."quotedUSDC"`;

    const [rows, [{ total }]] = await Promise.all([
      this.prisma.$queryRaw<CreditRow[]>`
        SELECT * FROM (${credits}) c
         ORDER BY "createdAt" DESC, id
         LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      this.prisma.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS total FROM (${credits}) c`,
    ]);
    return {
      items: rows.map((r) => ({ ...r, amountUSDC: new Decimal(r.amountUSDC) })),
      total,
    };
  }
}
