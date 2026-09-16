import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ANCHOR_ADAPTER,
  ANCHOR_ADAPTERS,
  AnchorAdapter,
  AnchorProviderName,
} from './anchor.adapter';
import { AnchorSession } from './anchor-session';
import { MockAnchorAdapter } from './mock-anchor.adapter';
import { Sep6AnchorAdapter } from './sep6-anchor.adapter';
import { Sep24AnchorAdapter } from './sep24-anchor.adapter';

/** Providers that talk to a real anchor over SEP-1/SEP-10 and so need ANCHOR_HOME_DOMAIN. */
const LIVE_ANCHOR_PROVIDERS: AnchorProviderName[] = ['sep24', 'sep6'];

@Module({
  providers: [
    AnchorSession,
    MockAnchorAdapter,
    Sep24AnchorAdapter,
    Sep6AnchorAdapter,
    {
      provide: ANCHOR_ADAPTERS,
      inject: [MockAnchorAdapter, Sep24AnchorAdapter, Sep6AnchorAdapter],
      useFactory: (
        mock: MockAnchorAdapter,
        sep24: Sep24AnchorAdapter,
        sep6: Sep6AnchorAdapter,
      ): Record<AnchorProviderName, AnchorAdapter> => ({ mock, sep24, sep6 }),
    },
    {
      provide: ANCHOR_ADAPTER,
      inject: [ConfigService, ANCHOR_ADAPTERS],
      useFactory: (
        config: ConfigService,
        adapters: Record<AnchorProviderName, AnchorAdapter>,
      ): AnchorAdapter => {
        const provider = config.get<AnchorProviderName>('ANCHOR_PROVIDER')!;
        if (
          LIVE_ANCHOR_PROVIDERS.includes(provider) &&
          !config.get<string>('ANCHOR_HOME_DOMAIN')
        ) {
          throw new Error(
            `ANCHOR_PROVIDER=${provider} needs ANCHOR_HOME_DOMAIN (sep6: tr-mock-anchor.fly.dev, sep24: testanchor.stellar.org)`,
          );
        }
        // tr-mock-anchor is a testnet sandbox that moves no real money; refuse it on pubnet.
        if (
          provider === 'sep6' &&
          config.get<string>('STELLAR_NETWORK') !== 'testnet'
        ) {
          throw new Error(
            'ANCHOR_PROVIDER=sep6 is testnet-only (tr-mock-anchor.fly.dev is a sandbox)',
          );
        }
        return adapters[provider];
      },
    },
  ],
  exports: [ANCHOR_ADAPTER, ANCHOR_ADAPTERS, AnchorSession],
})
export class AnchorModule {}
