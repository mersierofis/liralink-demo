import { Module } from '@nestjs/common';
import { FxModule } from '../fx/fx.module';
import { StellarModule } from '../stellar/stellar.module';
import { PayController } from './pay.controller';
import { PayService } from './pay.service';

@Module({
  imports: [FxModule, StellarModule],
  controllers: [PayController],
  providers: [PayService],
})
export class PayModule {}
