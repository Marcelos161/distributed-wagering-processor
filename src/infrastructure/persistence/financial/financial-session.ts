import type { InboxMessage } from '../../../domain/messaging/inbox-message.js';
import type { OutboxMessage } from '../../../domain/messaging/outbox-message.js';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { Wallet } from '../../../domain/wallet/wallet.js';
import type { WagerTransaction } from '../../../domain/wagering/wager-transaction.js';

// Object ownership only: never a distributed lock or an idempotency guarantee.
const messageOwners = new WeakMap<InboxMessage | OutboxMessage, symbol>();
const walletOwners = new WeakMap<Wallet, symbol>();
const transactionOwners = new WeakMap<WagerTransaction, symbol>();

export class FinancialSession {
  readonly #identity = Symbol('financial session');
  #active = true;
  #lastLockedId: string | undefined;
  readonly #wallets = new WeakMap<Wallet, { locked: boolean; version: number }>();

  constructor(private readonly em: EntityManager) {
    this.assertActive();
  }

  assertActive(): void {
    if (!this.#active || !this.em.isInTransaction()) throw new Error('Financial session is closed or outside a transaction');
  }

  attachMessage(message: InboxMessage | OutboxMessage): void {
    this.assertActive();
    const owner = messageOwners.get(message);
    if (owner && owner !== this.#identity) throw new Error('Reload message in the current transaction');
    messageOwners.set(message, this.#identity);
  }

  assertMessage(message: InboxMessage | OutboxMessage): void {
    this.assertActive();
    if (messageOwners.get(message) !== this.#identity) throw new Error('Load message with a lock in the current transaction');
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
    if (owner && owner !== this.#identity) throw new Error('Reload Wallet in the current transaction; do not reuse an earlier instance');
    walletOwners.set(wallet, this.#identity);
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
    if (owner && owner !== this.#identity) throw new Error('Reload WagerTransaction in the current transaction');
    transactionOwners.set(transaction, this.#identity);
  }

  assertTransaction(transaction: WagerTransaction): void {
    this.assertActive();
    if (transactionOwners.get(transaction) !== this.#identity) throw new Error('Load or insert WagerTransaction in the current transaction');
  }
}
