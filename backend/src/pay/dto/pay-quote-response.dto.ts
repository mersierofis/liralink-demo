import { ConfigService } from '@nestjs/config';
import { Payment, PaymentLink } from '../../generated/prisma/client';
import { PaymentResponseDto } from '../../payments/dto/payment-response.dto';

interface ContractRail {
  contractId: string;
  invoiceCode: string;
}

interface MemoRail {
  destination: string;
  memo: string;
}

export class PayQuoteResponseDto {
  code: string;
  merchantName: string;
  title: string;
  description?: string;
  amountTRY: string;
  amountUSDC: string;
  fxRate: string;
  quoteExpiresAt: string;
  status: string;
  expiresAt: string;
  receivedUSDC: string;
  shortfallUSDC?: string;
  // `contract` stays absent until the Soroban invoice contract is deployed;
  // `memo` (classic text-memo payment) is the only rail implemented so far.
  rails: { contract?: ContractRail; memo?: MemoRail };
  asset: { code: string; issuer: string };
  network: 'testnet';
  payment?: PaymentResponseDto;

  static build(
    link: PaymentLink & {
      merchant: { businessName: string };
      payment?: Payment | null;
    },
    config: ConfigService,
    platformPublicKey: string,
  ): PayQuoteResponseDto {
    const dto = new PayQuoteResponseDto();
    dto.code = link.code;
    dto.merchantName = link.merchant.businessName;
    dto.title = link.title;
    dto.description = link.description ?? undefined;
    dto.amountTRY = link.amountTRY.toFixed(2);
    dto.amountUSDC = link.quotedUSDC.toFixed(7);
    dto.fxRate = link.fxRate.toFixed(7);
    dto.quoteExpiresAt = link.quoteExpiresAt.toISOString();
    dto.status = link.status;
    dto.expiresAt = link.expiresAt.toISOString();
    dto.receivedUSDC = link.receivedUSDC.toFixed(7);
    dto.shortfallUSDC = link.shortfallUSDC?.toFixed(7) ?? undefined;
    dto.rails = { memo: { destination: platformPublicKey, memo: link.code } };
    dto.asset = {
      code: config.get<string>('USDC_CODE')!,
      issuer: config.get<string>('USDC_ISSUER')!,
    };
    dto.network = 'testnet';
    dto.payment = link.payment
      ? PaymentResponseDto.fromEntity(link.payment)
      : undefined;
    return dto;
  }
}
