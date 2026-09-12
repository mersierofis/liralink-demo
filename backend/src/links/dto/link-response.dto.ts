import { ConfigService } from '@nestjs/config';
import { PaymentResponseDto } from '../../payments/dto/payment-response.dto';
import { LinkWithRelations } from '../links.types';

export class LinkResponseDto {
  id: string;
  code: string;
  merchantId: string;
  merchantName: string;
  title: string;
  description?: string;
  amountTRY: string;
  quotedUSDC: string;
  fxRate: string;
  quoteExpiresAt: string;
  status: string;
  expiresAt: string;
  payUrl: string;
  payment?: PaymentResponseDto;
  createdAt: string;

  static fromEntity(
    link: LinkWithRelations,
    config: ConfigService,
  ): LinkResponseDto {
    const dto = new LinkResponseDto();
    dto.id = link.id;
    dto.code = link.code;
    dto.merchantId = link.merchantId;
    dto.merchantName = link.merchant.businessName;
    dto.title = link.title;
    dto.description = link.description ?? undefined;
    dto.amountTRY = link.amountTRY.toFixed(2);
    dto.quotedUSDC = link.quotedUSDC.toFixed(7);
    dto.fxRate = link.fxRate.toFixed(7);
    dto.quoteExpiresAt = link.quoteExpiresAt.toISOString();
    dto.status = link.status;
    dto.expiresAt = link.expiresAt.toISOString();
    dto.payUrl = `${config.get<string>('PAY_WEB_BASE_URL')}/${link.code}`;
    dto.payment = link.payment
      ? PaymentResponseDto.fromEntity(link.payment)
      : undefined;
    dto.createdAt = link.createdAt.toISOString();
    return dto;
  }
}
