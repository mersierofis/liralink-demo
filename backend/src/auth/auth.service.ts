import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { Merchant } from '../generated/prisma/client';
import { MerchantResponseDto } from '../merchants/dto/merchant-response.dto';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtPayload } from './jwt.strategy';

const BCRYPT_COST = 10;

export interface AuthResult {
  token: string;
  merchant: MerchantResponseDto;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResult> {
    const existing = await this.prisma.merchant.findUnique({
      where: { email: dto.email },
    });
    if (existing) throw new ConflictException('Email already registered');

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);
    const merchant = await this.prisma.merchant.create({
      data: { email: dto.email, passwordHash, businessName: dto.businessName },
    });

    return this.buildAuthResult(merchant);
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const merchant = await this.prisma.merchant.findUnique({
      where: { email: dto.email },
    });
    if (!merchant) throw new UnauthorizedException('Invalid credentials');

    const matches = await bcrypt.compare(dto.password, merchant.passwordHash);
    if (!matches) throw new UnauthorizedException('Invalid credentials');

    return this.buildAuthResult(merchant);
  }

  private buildAuthResult(merchant: Merchant): AuthResult {
    const payload: JwtPayload = { sub: merchant.id, email: merchant.email };
    return {
      token: this.jwtService.sign(payload),
      merchant: MerchantResponseDto.fromEntity(merchant),
    };
  }
}
