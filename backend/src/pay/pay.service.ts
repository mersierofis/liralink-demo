import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Decimal } from '../common/decimal';
import { FxService } from '../fx/fx.service';
import { PaymentResponseDto } from '../payments/dto/payment-response.dto';
import { PrismaService } from '../prisma/prisma.service';
import { InvoiceContractService } from '../stellar/invoice-contract.service';
import { PaymentListenerService } from '../stellar/payment-listener.service';
import { StellarService } from '../stellar/stellar.service';
import { PayQuoteResponseDto } from './dto/pay-quote-response.dto';

const LINK_INCLUDE = {
  merchant: { select: { businessName: true } },
  payments: { orderBy: { detectedAt: 'asc' } },
} as const;

@Injectable()
export class PayService {
  private readonly logger = new Logger(PayService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fxService: FxService,
    private readonly config: ConfigService,
    private readonly stellarService: StellarService,
    private readonly paymentListenerService: PaymentListenerService,
    private readonly invoiceContract: InvoiceContractService,
  ) {}

  async getQuote(code: string): Promise<PayQuoteResponseDto> {
    let link = await this.prisma.paymentLink.findUnique({
      where: { code },
      include: LINK_INCLUDE,
    });
    if (!link) throw new NotFoundException('Payment link not found');

    if (link.status === 'open' && link.quoteExpiresAt < new Date()) {
      link = await this.requote(link.id, link.amountTRY.toString());
    }

    return PayQuoteResponseDto.build(
      link,
      this.config,
      this.stellarService.platformPublicKey,
    );
  }

  private async requote(linkId: string, amountTRY: string) {
    const { rate, fetchedAt } = await this.fxService.getRate();
    const quotedUSDC = this.fxService.quote(new Decimal(amountTRY), rate);
    const quoteTtlMinutes = this.config.get<number>('QUOTE_TTL_MINUTES')!;
    const quoteExpiresAt = new Date(
      fetchedAt.getTime() + quoteTtlMinutes * 60_000,
    );

    // Conditional update: only the request that still sees an expired quote wins the write.
    // Concurrent pollers all re-read afterward, so they converge on whichever quote landed first.
    await this.prisma.paymentLink.updateMany({
      where: { id: linkId, status: 'open', quoteExpiresAt: { lt: new Date() } },
      data: { quotedUSDC, fxRate: rate, quoteExpiresAt },
    });

    return this.prisma.paymentLink.findUniqueOrThrow({
      where: { id: linkId },
      include: LINK_INCLUDE,
    });
  }

  async submitted(code: string, txHash: string): Promise<void> {
    const link = await this.prisma.paymentLink.findUnique({ where: { code } });
    if (!link) throw new NotFoundException('Payment link not found');

    this.paymentListenerService
      .checkTransactionHash(txHash)
      .catch((err: unknown) => {
        this.logger.warn(
          `submitted-hint check failed for ${txHash}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    // A contract-rail payment is an invoke_host_function the Horizon check above ignores;
    // pull its `paid` event now instead of waiting for the next poll (errors are logged inside).
    void this.invoiceContract.pollEvents();
  }

  async getStatus(code: string): Promise<{
    status: string;
    receivedUSDC: string;
    shortfallUSDC?: string;
    payment?: PaymentResponseDto;
    payments: PaymentResponseDto[];
  }> {
    const link = await this.prisma.paymentLink.findUnique({
      where: { code },
      include: { payments: { orderBy: { detectedAt: 'asc' } } },
    });
    if (!link) throw new NotFoundException('Payment link not found');
    const payments = link.payments.map((p) => PaymentResponseDto.fromEntity(p));
    return {
      status: link.status,
      receivedUSDC: link.receivedUSDC.toFixed(7),
      shortfallUSDC: link.shortfallUSDC?.toFixed(7) ?? undefined,
      // `payment` = completing/most-recent transfer (backward compat); `payments` = all.
      payment: payments.at(-1),
      payments,
    };
  }
}
