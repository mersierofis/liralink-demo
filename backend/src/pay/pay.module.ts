import { Module } from '@nestjs/common';
import { FxModule } from '../fx/fx.module';
import { PaymentsModule } from '../payments/payments.module';
import { StellarModule } from '../stellar/stellar.module';
import { PayController } from './pay.controller';
import { PayService } from './pay.service';
import { X402Service } from './x402.service';

@Module({
  imports: [FxModule, StellarModule, PaymentsModule],
  controllers: [PayController],
  providers: [PayService, X402Service],
})
export class PayModule {}
