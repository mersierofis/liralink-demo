import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/** Throttle per signed-in merchant instead of per IP (runs after JwtAuthGuard). */
@Injectable()
export class MerchantThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, any>): Promise<string> {
    const id = (req.user as { id?: string } | undefined)?.id;
    return Promise.resolve(id ?? String(req.ip));
  }
}
