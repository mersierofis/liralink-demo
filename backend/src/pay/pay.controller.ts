import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { PayQuoteResponseDto } from './dto/pay-quote-response.dto';
import { SubmittedDto } from './dto/submitted.dto';
import { PayService } from './pay.service';
import { AgentPayResult, X402Service } from './x402.service';

@UseGuards(ThrottlerGuard)
@Controller('pay')
export class PayController {
  constructor(
    private readonly payService: PayService,
    private readonly x402Service: X402Service,
  ) {}

  /** x402: 402 with payment requirements, or 200 with a receipt once PAYMENT-SIGNATURE settles. */
  @Get(':code/agent')
  async agent(
    @Param('code') code: string,
    @Headers('payment-signature') paymentSignature: string | undefined,
    @Headers('x-payment') legacyPayment: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AgentPayResult['body']> {
    const proto = req.get('x-forwarded-proto') ?? req.protocol;
    const result = await this.x402Service.handle(
      code.toUpperCase(),
      paymentSignature ?? legacyPayment,
      `${proto}://${req.get('host')}${req.originalUrl}`,
    );
    res.status(result.status).set(result.headers);
    return result.body;
  }

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
