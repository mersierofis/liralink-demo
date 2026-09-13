import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UnallocatedController } from './unallocated.controller';
import { UnallocatedService } from './unallocated.service';

@Module({
  imports: [AuthModule],
  controllers: [UnallocatedController],
  providers: [UnallocatedService],
})
export class UnallocatedModule {}
