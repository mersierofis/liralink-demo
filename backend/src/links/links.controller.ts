import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CurrentMerchant } from '../auth/current-merchant.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { Merchant } from '../generated/prisma/client';
import { CreateLinkDto } from './dto/create-link.dto';
import { LinkResponseDto } from './dto/link-response.dto';
import { ListLinksQueryDto } from './dto/list-links.dto';
import { LinksService } from './links.service';

@UseGuards(JwtAuthGuard)
@Controller('links')
export class LinksController {
  constructor(
    private readonly linksService: LinksService,
    private readonly config: ConfigService,
  ) {}

  @Post()
  async create(
    @CurrentMerchant() merchant: Merchant,
    @Body() dto: CreateLinkDto,
  ): Promise<LinkResponseDto> {
    const link = await this.linksService.create(merchant.id, dto);
    return LinkResponseDto.fromEntity(link, this.config);
  }

  @Get()
  async findAll(
    @CurrentMerchant() merchant: Merchant,
    @Query() query: ListLinksQueryDto,
  ) {
    const { items, total } = await this.linksService.findAll(
      merchant.id,
      query,
    );
    return {
      items: items.map((link) => LinkResponseDto.fromEntity(link, this.config)),
      total,
    };
  }

  @Get(':id')
  async findOne(
    @CurrentMerchant() merchant: Merchant,
    @Param('id') id: string,
  ): Promise<LinkResponseDto> {
    const link = await this.linksService.findOneForMerchant(merchant.id, id);
    return LinkResponseDto.fromEntity(link, this.config);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @CurrentMerchant() merchant: Merchant,
    @Param('id') id: string,
  ): Promise<LinkResponseDto> {
    const link = await this.linksService.cancel(merchant.id, id);
    return LinkResponseDto.fromEntity(link, this.config);
  }
}
