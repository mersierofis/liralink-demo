import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FxModule } from '../fx/fx.module';
import { LinksController } from './links.controller';
import { LinksService } from './links.service';

@Module({
  imports: [AuthModule, FxModule],
  controllers: [LinksController],
  providers: [LinksService],
  exports: [LinksService],
})
export class LinksModule {}
