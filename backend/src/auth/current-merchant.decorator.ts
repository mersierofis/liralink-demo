import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import type { Merchant } from '../generated/prisma/client';

interface RequestWithMerchant extends Request {
  user: Merchant;
}

export const CurrentMerchant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Merchant => {
    const request = ctx.switchToHttp().getRequest<RequestWithMerchant>();
    return request.user;
  },
);
