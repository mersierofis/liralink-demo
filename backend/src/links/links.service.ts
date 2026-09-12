import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Decimal } from '../common/decimal';
import { Paginated } from '../common/dto/pagination.dto';
import { FxService } from '../fx/fx.service';
import { PrismaService } from '../prisma/prisma.service';
import { generateLinkCode } from './code-generator';
import { CreateLinkDto } from './dto/create-link.dto';
import { ListLinksQueryDto } from './dto/list-links.dto';
import { LINK_INCLUDE, LinkWithRelations } from './links.types';

const MIN_AMOUNT_TRY = new Decimal('1.00');
const MAX_AMOUNT_TRY = new Decimal('1000000');
const MAX_CODE_RETRIES = 5;

@Injectable()
export class LinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fxService: FxService,
    private readonly config: ConfigService,
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

    return this.createWithRetry(
      merchantId,
      dto,
      amountTRY,
      quotedUSDC,
      rate,
      quoteExpiresAt,
      expiresAt,
    );
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
    return this.prisma.paymentLink.update({
      where: { id },
      data: { status: 'cancelled' },
      include: LINK_INCLUDE,
    });
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async expireOverdueLinks(): Promise<void> {
    await this.prisma.paymentLink.updateMany({
      where: { status: 'open', expiresAt: { lt: new Date() } },
      data: { status: 'expired' },
    });
  }
}
