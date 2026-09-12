import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { BCRYPT_COST } from '../auth/auth.service';
import { Merchant, Prisma } from '../generated/prisma/client';
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

  /** Profile fields, plus an optional password change: `newPassword` needs the right
   * `currentPassword`. Wrong password is 403, not 401 — clients log out on 401. */
  async update(id: string, dto: UpdateMerchantDto): Promise<Merchant> {
    const { currentPassword, newPassword, ...profile } = dto;
    const data: Prisma.MerchantUpdateInput = { ...profile };

    if (currentPassword !== undefined || newPassword !== undefined) {
      if (!currentPassword || !newPassword) {
        throw new BadRequestException(
          'currentPassword and newPassword must be sent together',
        );
      }
      const merchant = await this.findByIdOrThrow(id);
      const matches = await bcrypt.compare(
        currentPassword,
        merchant.passwordHash,
      );
      if (!matches) {
        throw new ForbiddenException('currentPassword is incorrect');
      }
      data.passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    }

    return this.prisma.merchant.update({ where: { id }, data });
  }
}
