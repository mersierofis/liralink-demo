import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
    return {
      ok: horizonUp,
      horizon: horizonUp ? 'up' : 'down',
      anchor: this.config.get<string>('ANCHOR_PROVIDER'),
      listener: this.listenerStatus.get(),
      platformAccount: this.stellarService.platformPublicKey,
    };
  }
}
