import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { FxModule } from '../fx/fx.module';
import { PaymentsModule } from '../payments/payments.module';
import { StellarModule } from '../stellar/stellar.module';
import { PayController } from './pay.controller';
import { PayService } from './pay.service';
import { X402_FACILITATOR, X402Service } from './x402.service';

@Module({
  imports: [FxModule, StellarModule, PaymentsModule],
  controllers: [PayController],
  providers: [
    PayService,
    X402Service,
    {
      // null disables x402: no facilitator URL, or not testnet (x402.org has no pubnet).
      provide: X402_FACILITATOR,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('X402_FACILITATOR_URL');
        return url && config.get<string>('STELLAR_NETWORK') === 'testnet'
          ? new HTTPFacilitatorClient({ url })
          : null;
      },
    },
  ],
})
export class PayModule {}
