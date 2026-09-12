import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ANCHOR_ADAPTER, AnchorAdapter } from './anchor.adapter';
import { MockAnchorAdapter } from './mock-anchor.adapter';

@Module({
  providers: [
    MockAnchorAdapter,
    {
      provide: ANCHOR_ADAPTER,
      inject: [ConfigService, MockAnchorAdapter],
      useFactory: (
        config: ConfigService,
        mock: MockAnchorAdapter,
      ): AnchorAdapter => {
        const provider = config.get<string>('ANCHOR_PROVIDER');
        if (provider !== 'mock') {
          throw new Error(
            `ANCHOR_PROVIDER=${provider} is not implemented yet (SEP-24 adapter is phase 2 part E) — use mock`,
          );
        }
        return mock;
      },
    },
  ],
  exports: [ANCHOR_ADAPTER],
})
export class AnchorModule {}
