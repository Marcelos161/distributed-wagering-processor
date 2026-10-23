import type { InboxRepository, OutboxRepository } from './message-persistence.js';
import type { WagerAdmissionRepository, WagerResultRepository } from './wager-persistence.js';
import type { Wallet } from '../../domain/wallet/wallet.js';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry.js';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction.js';

export interface WalletRepository {
  findById(id: string): Promise<Wallet | null>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
  findByIdForUpdate(id: string): Promise<Wallet | null>;
  insert(wallet: Wallet): Promise<void>;
  /** Persist exactly one movement on a wallet locked/inserted in this scope. */
  save(wallet: Wallet): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | null>;
  findByExternalId(providerId: string, externalId: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(providerId: string, key: string): Promise<WagerTransaction | null>;
  insert(transaction: WagerTransaction): Promise<void>;
  updateLifecycle(transaction: WagerTransaction): Promise<void>;
}

export interface PersistedLedgerEntry {
  readonly entry: WalletLedgerEntry;
  readonly walletVersion: number;
}

export interface LedgerEntryRepository {
  insert(entry: WalletLedgerEntry, walletVersion: number): Promise<void>;
  listByWalletId(walletId: string): Promise<readonly PersistedLedgerEntry[]>;
}

export interface FinancialRepositories {
  readonly wagerAdmission: WagerAdmissionRepository;
  readonly wagerResults: WagerResultRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerEntryRepository;
}

export interface FinancialUnitOfWork {
  run<T>(work: (repositories: FinancialRepositories) => Promise<T>): Promise<T>;
}

export const FINANCIAL_UNIT_OF_WORK = Symbol('FinancialUnitOfWork');
