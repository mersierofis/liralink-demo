import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Per-merchant /agent/chat requests per UTC day, in memory (resets on restart). */
@Injectable()
export class DailyLimiter {
  private readonly counts = new Map<string, { day: string; count: number }>();

  constructor(private readonly config: ConfigService) {}

  hit(merchantId: string): void {
    const limit = this.config.get<number>('AGENT_DAILY_LIMIT') ?? 200;
    const day = new Date().toISOString().slice(0, 10);
    const entry = this.counts.get(merchantId);
    if (!entry || entry.day !== day) {
      this.counts.set(merchantId, { day, count: 1 });
      this.dropOldDays(day);
      return;
    }
    if (entry.count >= limit) {
      throw new HttpException(
        `You've reached today's limit of ${limit} assistant messages. It resets at 00:00 UTC. The rest of the panel works as usual.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    entry.count += 1;
  }

  private dropOldDays(today: string): void {
    for (const [id, e] of this.counts)
      if (e.day !== today) this.counts.delete(id);
  }
}
