import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ANCHOR_ADAPTER,
  ANCHOR_ADAPTERS,
  AnchorAdapter,
  AnchorProviderName,
} from './anchor.adapter';
import { MockAnchorAdapter } from './mock-anchor.adapter';
import { Sep24AnchorAdapter } from './sep24-anchor.adapter';

@Module({
  providers: [
    MockAnchorAdapter,
    Sep24AnchorAdapter,
    {
      provide: ANCHOR_ADAPTERS,
      inject: [MockAnchorAdapter, Sep24AnchorAdapter],
      useFactory: (
        mock: MockAnchorAdapter,
        sep24: Sep24AnchorAdapter,
      ): Record<AnchorProviderName, AnchorAdapter> => ({ mock, sep24 }),
    },
    {
      provide: ANCHOR_ADAPTER,
      inject: [ConfigService, ANCHOR_ADAPTERS],
      useFactory: (
        config: ConfigService,
        adapters: Record<AnchorProviderName, AnchorAdapter>,
      ): AnchorAdapter => {
        const provider = config.get<AnchorProviderName>('ANCHOR_PROVIDER')!;
        if (provider === 'sep24' && !config.get<string>('ANCHOR_HOME_DOMAIN')) {
          throw new Error(
            'ANCHOR_PROVIDER=sep24 needs ANCHOR_HOME_DOMAIN (e.g. testanchor.stellar.org)',
          );
        }
        return adapters[provider];
      },
    },
  ],
  exports: [ANCHOR_ADAPTER, ANCHOR_ADAPTERS],
})
export class AnchorModule {}
