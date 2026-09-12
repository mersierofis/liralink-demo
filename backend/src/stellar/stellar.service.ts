import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

@Injectable()
export class StellarService implements OnModuleInit {
  private readonly logger = new Logger(StellarService.name);

  readonly server: Horizon.Server;
  private readonly keypair: Keypair;
  readonly usdcAsset: Asset;
  private readonly networkPassphrase: string;

  constructor(private readonly config: ConfigService) {
    this.server = new Horizon.Server(this.config.get<string>('HORIZON_URL')!);
    this.keypair = Keypair.fromSecret(
      this.config.get<string>('PLATFORM_ACCOUNT_SECRET')!,
    );
    this.usdcAsset = new Asset(
      this.config.get<string>('USDC_CODE')!,
      this.config.get<string>('USDC_ISSUER'),
    );
    this.networkPassphrase = this.config.get<string>('NETWORK_PASSPHRASE')!;
  }

  get platformPublicKey(): string {
    return this.keypair.publicKey();
  }

  async onModuleInit(): Promise<void> {
    this.logger.log(`Platform account: ${this.platformPublicKey}`);

    const account = await this.server
      .loadAccount(this.platformPublicKey)
      .catch((err: unknown) => {
        throw new Error(
          `Platform account ${this.platformPublicKey} not found on ${this.config.get<string>('HORIZON_URL')} — ` +
            `fund it first (e.g. \`stellar keys fund\` on testnet). Original error: ${String(err)}`,
        );
      });

    const hasTrustline = account.balances.some(
      (b) =>
        b.asset_type !== 'native' &&
        'asset_code' in b &&
        b.asset_code === this.usdcAsset.getCode() &&
        b.asset_issuer === this.usdcAsset.getIssuer(),
    );

    if (hasTrustline) {
      this.logger.log(`USDC trustline already present on platform account`);
      return;
    }

    this.logger.warn(
      'USDC trustline missing on platform account — submitting changeTrust',
    );
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(Operation.changeTrust({ asset: this.usdcAsset }))
      .setTimeout(30)
      .build();
    tx.sign(this.keypair);
    const result = await this.server.submitTransaction(tx);
    this.logger.log(`USDC trustline established, tx hash: ${result.hash}`);
  }

  /** Cheap liveness probe for /health — does not imply the platform account/trustline are correct, only that Horizon answers. */
  async isHorizonUp(): Promise<boolean> {
    try {
      await this.server.ledgers().order('desc').limit(1).call();
      return true;
    } catch {
      return false;
    }
  }
}
