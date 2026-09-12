import { Controller, Get } from '@nestjs/common';
import { FxService } from './fx.service';

@Controller('fx')
export class FxController {
  constructor(private readonly fxService: FxService) {}

  @Get()
  async getFxRate() {
    const { rate, source, fetchedAt } = await this.fxService.getRate();
    return {
      pair: 'USDC/TRY',
      rate: rate.toFixed(2),
      source,
      fetchedAt: fetchedAt.toISOString(),
    };
  }
}
