import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Operation,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { Decimal } from '../common/decimal';
import {
  expired,
  findTransaction,
  httpStatus,
  submitSigned,
} from './signed-tx';

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

  /**
   * Why `destination` can't receive `amount` USDC right now, as a plain sentence for a 422 — or
   * null when it can. Other Horizon errors are thrown.
   */
  async usdcDestinationProblem(
    destination: string,
    amount: Decimal,
  ): Promise<string | null> {
    let account: Horizon.AccountResponse;
    try {
      account = await this.server.loadAccount(destination);
    } catch (err) {
      if (httpStatus(err) !== 404) throw err;
      return `Destination ${destination} does not exist on the Stellar testnet yet — fund it with XLM first`;
    }
    const line = this.usdcTrustline(account.balances);
    if (!line) {
      return `Destination ${destination} has no USDC trustline — add USDC (issuer ${this.usdcAsset.getIssuer()}) in the wallet first`;
    }
    const room = new Decimal(line.limit).minus(line.balance);
    if (amount.greaterThan(room)) {
      return `Destination ${destination} can only receive ${room.toFixed(7)} more USDC (trustline limit ${line.limit})`;
    }
    return null;
  }

  transactionFromXdr(xdr: string): Transaction {
    return new Transaction(xdr, this.networkPassphrase);
  }

  findTransaction(hash: string): Promise<{ successful: boolean } | null> {
    return findTransaction(this.server, hash);
  }

  expired(tx: Transaction): Promise<boolean> {
    return expired(this.server, tx);
  }

  submitSigned(tx: Transaction): Promise<void> {
    return submitSigned(this.server, tx);
  }

  /** A signed (not submitted) USDC payment from the platform account. Persist it before submitting. */
  async buildUsdcPayment(
    destination: string,
    amount: string,
    timeoutSeconds: number,
  ): Promise<Transaction> {
    const account = await this.server.loadAccount(this.platformPublicKey);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.payment({ destination, asset: this.usdcAsset, amount }),
      )
      .setTimeout(timeoutSeconds)
      .build();
    tx.sign(this.keypair);
    return tx;
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

    if (this.usdcTrustline(account.balances)) {
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

  private usdcTrustline(
    balances: Horizon.HorizonApi.BalanceLine[],
  ): { balance: string; limit: string } | undefined {
    for (const b of balances) {
      if (
        b.asset_type !== 'native' &&
        'asset_code' in b &&
        b.asset_code === this.usdcAsset.getCode() &&
        b.asset_issuer === this.usdcAsset.getIssuer()
      ) {
        return { balance: b.balance, limit: b.limit };
      }
    }
    return undefined;
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
