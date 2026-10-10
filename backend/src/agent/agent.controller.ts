import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentMerchant } from '../auth/current-merchant.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { Merchant } from '../generated/prisma/client';
import { AgentService } from './agent.service';
import { ChatDto } from './dto';
import { MerchantThrottlerGuard } from './merchant-throttler.guard';

@UseGuards(JwtAuthGuard)
@Controller('agent')
export class AgentController {
  constructor(private readonly agent: AgentService) {}

  @Post('chat')
  @HttpCode(HttpStatus.OK)
  @UseGuards(MerchantThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  chat(@CurrentMerchant() merchant: Merchant, @Body() dto: ChatDto) {
    return this.agent.chat(merchant, dto);
  }

  @Post('proposals/:id/confirm')
  confirm(@CurrentMerchant() merchant: Merchant, @Param('id') id: string) {
    return this.agent.confirm(merchant, id);
  }

  @Post('proposals/:id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@CurrentMerchant() merchant: Merchant, @Param('id') id: string) {
    return this.agent.cancel(merchant, id);
  }
}
