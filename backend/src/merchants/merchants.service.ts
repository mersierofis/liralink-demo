import { Injectable, NotFoundException } from '@nestjs/common';
import { Merchant } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateMerchantDto } from './dto/update-merchant.dto';

@Injectable()
export class MerchantsService {
  constructor(private readonly prisma: PrismaService) {}

  async findByIdOrThrow(id: string): Promise<Merchant> {
    const merchant = await this.prisma.merchant.findUnique({ where: { id } });
    if (!merchant) throw new NotFoundException('Merchant not found');
    return merchant;
  }

  async update(id: string, dto: UpdateMerchantDto): Promise<Merchant> {
    return this.prisma.merchant.update({ where: { id }, data: dto });
  }
}
