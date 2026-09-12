import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { settlementModeFor } from '../anchor/anchor.adapter';
import { ListenerStatusService } from '../stellar/listener-status.service';
import { StellarService } from '../stellar/stellar.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly stellarService: StellarService,
    private readonly listenerStatus: ListenerStatusService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  async getHealth() {
    const horizonUp = await this.stellarService.isHorizonUp();
    const anchor = this.config.get<string>('ANCHOR_PROVIDER')!;
    return {
      ok: horizonUp,
      horizon: horizonUp ? 'up' : 'down',
      anchor,
      listener: this.listenerStatus.get(),
      platformAccount: this.stellarService.platformPublicKey,
      settlementMode: settlementModeFor(anchor),
    };
  }
}
