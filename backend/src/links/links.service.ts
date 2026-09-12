import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Decimal } from '../common/decimal';
import { Paginated } from '../common/dto/pagination.dto';
import { FxService } from '../fx/fx.service';
import { PrismaService } from '../prisma/prisma.service';
import { InvoiceContractService } from '../stellar/invoice-contract.service';
import { generateLinkCode } from './code-generator';
import { CreateLinkDto } from './dto/create-link.dto';
import { ListLinksQueryDto } from './dto/list-links.dto';
import { LINK_INCLUDE, LinkWithRelations } from './links.types';

const MIN_AMOUNT_TRY = new Decimal('1.00');
const MAX_AMOUNT_TRY = new Decimal('1000000');
const MAX_CODE_RETRIES = 5;
// A link about to expire isn't worth an on-chain invoice the payer can't realistically use.
const MIN_ONCHAIN_LIFETIME_MS = 2 * 60_000;

@Injectable()
export class LinksService {
  private readonly logger = new Logger(LinksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fxService: FxService,
    private readonly config: ConfigService,
    private readonly invoiceContract: InvoiceContractService,
  ) {}

  async create(merchantId: string, dto: CreateLinkDto) {
    const amountTRY = new Decimal(dto.amountTRY);
    if (
      amountTRY.lessThan(MIN_AMOUNT_TRY) ||
      amountTRY.greaterThan(MAX_AMOUNT_TRY)
    ) {
      throw new BadRequestException(
        `amountTRY must be between ${MIN_AMOUNT_TRY.toFixed(2)} and ${MAX_AMOUNT_TRY.toFixed(2)}`,
      );
    }

    const { rate, fetchedAt } = await this.fxService.getRate();
    const quotedUSDC = this.fxService.quote(amountTRY, rate);
    const quoteTtlMinutes = this.config.get<number>('QUOTE_TTL_MINUTES')!;
    const expiresInHours =
      dto.expiresInHours ??
      this.config.get<number>('LINK_DEFAULT_EXPIRY_HOURS')!;

    const now = fetchedAt;
    const quoteExpiresAt = new Date(now.getTime() + quoteTtlMinutes * 60_000);
    const expiresAt = new Date(now.getTime() + expiresInHours * 3_600_000);

    const link = await this.createWithRetry(
      merchantId,
      dto,
      amountTRY,
      quotedUSDC,
      rate,
      quoteExpiresAt,
      expiresAt,
    );
    return this.tryPutOnchain(link);
  }

  /** Best-effort on-chain invoice at creation: an RPC failure never fails POST /links — the link
   * comes back with `onchain: null` and POST /links/:id/onchain is the manual retry. */
  private async tryPutOnchain(
    link: LinkWithRelations,
  ): Promise<LinkWithRelations> {
    const contractId = this.invoiceContract.contractId;
    if (!contractId) return link;
    try {
      await this.recordOnchain(link, contractId);
      return await this.findOneForMerchant(link.merchantId, link.id);
    } catch (err) {
      this.logger.warn(
        `Link ${link.code} created without an on-chain invoice (retry: POST /links/${link.id}/onchain): ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return link;
    }
  }

  private async createWithRetry(
    merchantId: string,
    dto: CreateLinkDto,
    amountTRY: Decimal,
    quotedUSDC: Decimal,
    fxRate: Decimal,
    quoteExpiresAt: Date,
    expiresAt: Date,
    attempt = 0,
  ): Promise<LinkWithRelations> {
    const code = generateLinkCode();
    try {
      return await this.prisma.paymentLink.create({
        data: {
          code,
          merchantId,
          title: dto.title,
          description: dto.description,
          amountTRY,
          quotedUSDC,
          fxRate,
          quoteExpiresAt,
          expiresAt,
        },
        include: LINK_INCLUDE,
      });
    } catch (err) {
      if (this.isUniqueViolation(err) && attempt < MAX_CODE_RETRIES) {
        return this.createWithRetry(
          merchantId,
          dto,
          amountTRY,
          quotedUSDC,
          fxRate,
          quoteExpiresAt,
          expiresAt,
          attempt + 1,
        );
      }
      throw err;
    }
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      err.code === 'P2002'
    );
  }

  async findAll(
    merchantId: string,
    query: ListLinksQueryDto,
  ): Promise<Paginated<LinkWithRelations>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where = {
      merchantId,
      ...(query.status ? { status: query.status } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.paymentLink.findMany({
        where,
        include: LINK_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.paymentLink.count({ where }),
    ]);

    return { items, total };
  }

  async findOneForMerchant(
    merchantId: string,
    id: string,
  ): Promise<LinkWithRelations> {
    const link = await this.prisma.paymentLink.findUnique({
      where: { id },
      include: LINK_INCLUDE,
    });
    if (!link || link.merchantId !== merchantId)
      throw new NotFoundException('Payment link not found');
    return link;
  }

  async cancel(merchantId: string, id: string) {
    const link = await this.findOneForMerchant(merchantId, id);
    if (link.status !== 'open') {
      throw new ConflictException(
        `Cannot cancel a link with status "${link.status}"`,
      );
    }
    if (link.contractId === this.invoiceContract.contractId) {
      await this.cancelOnchain(link.code);
    }
    return this.prisma.paymentLink.update({
      where: { id },
      data: { status: 'cancelled' },
      include: LINK_INCLUDE,
    });
  }

  /**
   * Manual retry for a link whose best-effort on-chain invoice failed at creation. Calling it
   * for a link already on the current contract returns the link unchanged.
   */
  async putOnchain(merchantId: string, id: string): Promise<LinkWithRelations> {
    const contractId = this.invoiceContract.contractId;
    if (!contractId) {
      throw new ServiceUnavailableException(
        'The Soroban invoice contract is not configured',
      );
    }
    const link = await this.findOneForMerchant(merchantId, id);
    if (link.contractId === contractId) return link;
    if (link.status !== 'open' || link.receivedUSDC.greaterThan(0)) {
      throw new ConflictException(
        `Cannot put a link on-chain once it is "${link.status}" or has received a payment`,
      );
    }
    await this.recordOnchain(link, contractId);
    return this.findOneForMerchant(merchantId, id);
  }

  /**
   * Records the link as an invoice on the Soroban contract (`rails.contract`) at its current
   * `quotedUSDC` — never re-quoted — and locks that quote until the link expires, since the
   * on-chain amount can't follow a re-quote (locked-FX policy).
   */
  private async recordOnchain(
    link: LinkWithRelations,
    contractId: string,
  ): Promise<void> {
    const id = link.id;
    if (link.expiresAt.getTime() - Date.now() < MIN_ONCHAIN_LIFETIME_MS) {
      throw new ConflictException('Link expires too soon to put on-chain');
    }

    const invoice = await this.invoiceContract.createInvoice(
      link.code,
      link.quotedUSDC,
      link.expiresAt,
    );
    // Normally the amount we sent; differs only if an earlier attempt already created it.
    const fxRate = link.amountTRY.div(invoice.amountUSDC).toDecimalPlaces(7);

    const { count } = await this.prisma.paymentLink.updateMany({
      where: { id, status: 'open', receivedUSDC: 0 },
      data: {
        quotedUSDC: invoice.amountUSDC,
        fxRate,
        quoteExpiresAt: link.expiresAt,
        contractId,
        contractTxHash: invoice.txHash,
        contractDeadlineLedger: invoice.deadlineLedger,
      },
    });
    if (count === 0) {
      // Paid or cancelled while the invoice was being created — don't leave it payable on-chain.
      await this.cancelOnchain(link.code);
      throw new ConflictException('Link changed while putting it on-chain');
    }
    this.logger.log(
      `Link ${link.code} on-chain: ${invoice.amountUSDC.toFixed(7)} USDC until ledger ` +
        `${invoice.deadlineLedger}, tx ${invoice.txHash ?? '(already existed)'}`,
    );
  }

  /** Best-effort: if this fails, a later contract payment is still detected and lands as stray
   * (credited to the merchant's unallocatedUSDC), so the link cancel itself never blocks on RPC. */
  private async cancelOnchain(code: string): Promise<void> {
    try {
      await this.invoiceContract.cancelInvoice(code);
    } catch (err) {
      this.logger.warn(
        `On-chain cancel of invoice ${code} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async expireOverdueLinks(): Promise<void> {
    await this.prisma.paymentLink.updateMany({
      where: { status: 'open', expiresAt: { lt: new Date() } },
      data: { status: 'expired' },
    });
  }
}
