import { Module } from '@nestjs/common';
import { AnchorModule } from '../anchor/anchor.module';
import { FxController } from './fx.controller';
import { FxService } from './fx.service';

@Module({
  // FX_PROVIDER=anchor prices links off the anchor's SEP-38 quote server, discovered through the
  // same stellar.toml/SEP-10 session the settlement adapters use.
  imports: [AnchorModule],
  controllers: [FxController],
  providers: [FxService],
  exports: [FxService],
})
export class FxModule {}
