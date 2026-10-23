import { readTimestamp } from './timestamp-mapper.js';
import { LedgerDirection, WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger-entry.js';
import { MoneyMapper, readVersion, writeVersion } from './money-mapper.js';

export interface LedgerEntryRecord {
  id: string; wallet_id: string; transaction_id: string; wallet_version: string;
  direction: string; amount: string; currency: string; balance_before: string; balance_after: string;
  created_at: Date | string;
}

export interface VersionedLedgerEntry {
  readonly entry: WalletLedgerEntry;
  readonly walletVersion: number;
}

export class LedgerEntryMapper {
  static toDomain(row: LedgerEntryRecord): VersionedLedgerEntry {
    return Object.freeze({ walletVersion: readVersion(row.wallet_version),
      entry: WalletLedgerEntry.rehydrate({ id: row.id, walletId: row.wallet_id,
        transactionId: row.transaction_id, direction: row.direction as LedgerDirection,
        money: MoneyMapper.toDomain(row.amount, row.currency),
        balanceBefore: MoneyMapper.toDomain(row.balance_before, row.currency),
        balanceAfter: MoneyMapper.toDomain(row.balance_after, row.currency), createdAt: readTimestamp(row.created_at) }) });
  }

  static toRecord(entry: WalletLedgerEntry, walletVersion: number): LedgerEntryRecord {
    return { id: entry.id, wallet_id: entry.walletId, transaction_id: entry.transactionId,
      wallet_version: writeVersion(walletVersion), direction: entry.direction,
      amount: MoneyMapper.toRecord(entry.money), currency: entry.money.currency,
      balance_before: MoneyMapper.toRecord(entry.balanceBefore),
      balance_after: MoneyMapper.toRecord(entry.balanceAfter), created_at: entry.createdAt };
  }
}
