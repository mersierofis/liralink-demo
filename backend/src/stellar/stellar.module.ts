import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { ListenerStatusService } from './listener-status.service';
import { PaymentListenerService } from './payment-listener.service';
import { StellarService } from './stellar.service';

@Module({
  imports: [PaymentsModule],
  providers: [StellarService, ListenerStatusService, PaymentListenerService],
  exports: [StellarService, ListenerStatusService, PaymentListenerService],
})
export class StellarModule {}
