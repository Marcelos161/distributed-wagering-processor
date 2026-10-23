import type { EntityManager } from '@mikro-orm/postgresql';
import type { Wallet } from '../../../domain/wallet/wallet.js';
import type { WagerTransaction } from '../../../domain/wagering/wager-transaction.js';

// Object ownership only: never a distributed lock or an idempotency guarantee.
const walletOwners = new WeakMap<Wallet, FinancialSession>();
const transactionOwners = new WeakMap<WagerTransaction, FinancialSession>();

export class FinancialSession {
  #active = true;
  #lastLockedId: string | undefined;
  readonly #wallets = new WeakMap<Wallet, { locked: boolean; version: number }>();

  constructor(private readonly em: EntityManager) {
    this.assertActive();
  }

  assertActive(): void {
    if (!this.#active || !this.em.isInTransaction()) throw new Error('Financial session is closed or outside a transaction');
  }

  close(): void { this.#active = false; }

  async execute<T extends object[] = object[]>(sql: string, parameters: readonly unknown[] = []): Promise<T> {
    this.assertActive();
    return this.em.execute<T>(sql, [...parameters]);
  }

  beforeLock(id: string): void {
    this.assertActive();
    if (this.#lastLockedId !== undefined && id < this.#lastLockedId) {
      throw new Error('Acquire wallet locks in ascending identifier order');
    }
    this.#lastLockedId = id;
  }

  attachWallet(wallet: Wallet, locked: boolean): void {
    this.assertActive();
    const owner = walletOwners.get(wallet);
    if (owner && owner !== this) throw new Error('Reload Wallet in the current transaction; do not reuse an earlier instance');
    walletOwners.set(wallet, this);
    this.#wallets.set(wallet, { locked, version: wallet.version });
  }

  versionBeforeSave(wallet: Wallet): number {
    this.assertActive();
    const state = this.#wallets.get(wallet);
    if (!state?.locked) throw new Error('Load Wallet with a lock in this transaction before saving');
    if (wallet.version !== state.version + 1) throw new Error('Persist each wallet movement separately');
    return state.version;
  }

  saved(wallet: Wallet): void {
    this.attachWallet(wallet, true);
  }

  attachTransaction(transaction: WagerTransaction): void {
    this.assertActive();
    const owner = transactionOwners.get(transaction);
    if (owner && owner !== this) throw new Error('Reload WagerTransaction in the current transaction');
    transactionOwners.set(transaction, this);
  }

  assertTransaction(transaction: WagerTransaction): void {
    this.assertActive();
    if (transactionOwners.get(transaction) !== this) throw new Error('Load or insert WagerTransaction in the current transaction');
  }
}
