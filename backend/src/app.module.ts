import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from './config/config.module';
import { FxModule } from './fx/fx.module';
import { HealthModule } from './health/health.module';
import { LinksModule } from './links/links.module';
import { MerchantsModule } from './merchants/merchants.module';
import { PayModule } from './pay/pay.module';
import { PrismaModule } from './prisma/prisma.module';
import { StellarModule } from './stellar/stellar.module';

@Module({
  imports: [
    ConfigModule,
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 10_000, limit: 20 }]),
    PrismaModule,
    AuthModule,
    MerchantsModule,
    FxModule,
    LinksModule,
    StellarModule,
    HealthModule,
    PayModule,
  ],
})
export class AppModule {}
