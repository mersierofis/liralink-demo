import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BalanceModule } from '../balance/balance.module';
import { StellarModule } from '../stellar/stellar.module';
import { UsdcWithdrawalsController } from './usdc-withdrawals.controller';
import { UsdcWithdrawalsService } from './usdc-withdrawals.service';

@Module({
  imports: [AuthModule, BalanceModule, StellarModule],
  controllers: [UsdcWithdrawalsController],
  providers: [UsdcWithdrawalsService],
})
export class UsdcWithdrawalsModule {}
