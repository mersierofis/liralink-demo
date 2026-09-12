import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  settlementModeFor,
  type SettlementMode,
} from '../anchor/anchor.adapter';
import { CurrentMerchant } from '../auth/current-merchant.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { Merchant } from '../generated/prisma/client';
import { MerchantResponseDto } from './dto/merchant-response.dto';
import { UpdateMerchantDto } from './dto/update-merchant.dto';
import { MerchantsService } from './merchants.service';

@UseGuards(JwtAuthGuard)
@Controller('me')
export class MerchantsController {
  constructor(
    private readonly merchantsService: MerchantsService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  getMe(@CurrentMerchant() merchant: Merchant): MerchantResponseDto {
    return MerchantResponseDto.fromEntity(merchant, this.settlementMode());
  }

  @Patch()
  async updateMe(
    @CurrentMerchant() merchant: Merchant,
    @Body() dto: UpdateMerchantDto,
  ): Promise<MerchantResponseDto> {
    const updated = await this.merchantsService.update(merchant.id, dto);
    return MerchantResponseDto.fromEntity(updated, this.settlementMode());
  }

  private settlementMode(): SettlementMode {
    return settlementModeFor(this.config.get<string>('ANCHOR_PROVIDER')!);
  }
}
