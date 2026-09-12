import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { CurrentMerchant } from '../auth/current-merchant.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { Merchant } from '../generated/prisma/client';
import { MerchantResponseDto } from './dto/merchant-response.dto';
import { UpdateMerchantDto } from './dto/update-merchant.dto';
import { MerchantsService } from './merchants.service';

@UseGuards(JwtAuthGuard)
@Controller('me')
export class MerchantsController {
  constructor(private readonly merchantsService: MerchantsService) {}

  @Get()
  getMe(@CurrentMerchant() merchant: Merchant): MerchantResponseDto {
    return MerchantResponseDto.fromEntity(merchant);
  }

  @Patch()
  async updateMe(
    @CurrentMerchant() merchant: Merchant,
    @Body() dto: UpdateMerchantDto,
  ): Promise<MerchantResponseDto> {
    const updated = await this.merchantsService.update(merchant.id, dto);
    return MerchantResponseDto.fromEntity(updated);
  }
}
