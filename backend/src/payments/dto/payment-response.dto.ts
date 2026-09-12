import { Payment } from '../../generated/prisma/client';
import { explorerTxUrl } from '../../common/explorer';

export class PaymentResponseDto {
  id: string;
  linkId: string;
  txHash: string;
  payerAddress: string;
  amountUSDC: string;
  ledger: number;
  explorerUrl: string;
  detectedAt: string;

  static fromEntity(payment: Payment): PaymentResponseDto {
    const dto = new PaymentResponseDto();
    dto.id = payment.id;
    dto.linkId = payment.linkId;
    dto.txHash = payment.txHash;
    dto.payerAddress = payment.payerAddress;
    dto.amountUSDC = payment.amountUSDC.toFixed(7);
    dto.ledger = payment.ledger;
    dto.explorerUrl = explorerTxUrl(payment.txHash);
    dto.detectedAt = payment.detectedAt.toISOString();
    return dto;
  }
}
