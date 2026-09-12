import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { InvoiceContractService } from './invoice-contract.service';
import { ListenerStatusService } from './listener-status.service';
import { PaymentListenerService } from './payment-listener.service';
import { StellarService } from './stellar.service';

@Module({
  imports: [PaymentsModule],
  providers: [
    StellarService,
    ListenerStatusService,
    PaymentListenerService,
    InvoiceContractService,
  ],
  exports: [
    StellarService,
    ListenerStatusService,
    PaymentListenerService,
    InvoiceContractService,
  ],
})
export class StellarModule {}
