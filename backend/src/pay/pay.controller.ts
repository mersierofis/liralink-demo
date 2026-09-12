import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { PayQuoteResponseDto } from './dto/pay-quote-response.dto';
import { SubmittedDto } from './dto/submitted.dto';
import { PayService } from './pay.service';

@UseGuards(ThrottlerGuard)
@Controller('pay')
export class PayController {
  constructor(private readonly payService: PayService) {}

  @Get(':code')
  getQuote(@Param('code') code: string): Promise<PayQuoteResponseDto> {
    return this.payService.getQuote(code.toUpperCase());
  }

  @Post(':code/submitted')
  @HttpCode(HttpStatus.ACCEPTED)
  async submitted(
    @Param('code') code: string,
    @Body() dto: SubmittedDto,
  ): Promise<{ accepted: true }> {
    await this.payService.submitted(code.toUpperCase(), dto.txHash);
    return { accepted: true };
  }

  @Get(':code/status')
  getStatus(@Param('code') code: string) {
    return this.payService.getStatus(code.toUpperCase());
  }
}
