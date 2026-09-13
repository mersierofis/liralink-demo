import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { BalanceModule } from './balance/balance.module';
import { ConfigModule } from './config/config.module';
import { FxModule } from './fx/fx.module';
import { HealthModule } from './health/health.module';
import { LinksModule } from './links/links.module';
import { MerchantsModule } from './merchants/merchants.module';
import { PayModule } from './pay/pay.module';
import { PrismaModule } from './prisma/prisma.module';
import { SettlementsModule } from './settlements/settlements.module';
import { StellarModule } from './stellar/stellar.module';
import { UnallocatedModule } from './unallocated/unallocated.module';
import { WithdrawalsModule } from './withdrawals/withdrawals.module';

@Module({
  imports: [
    ConfigModule,
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 10_000, limit: 20 }]),
    PrismaModule,
    AuthModule,
    MerchantsModule,
    BalanceModule,
    FxModule,
    LinksModule,
    StellarModule,
    HealthModule,
    PayModule,
    SettlementsModule,
    WithdrawalsModule,
    UnallocatedModule,
  ],
})
export class AppModule {}
