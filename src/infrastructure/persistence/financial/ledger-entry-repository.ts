import type { LedgerEntryRepository, PersistedLedgerEntry } from '../../../application/ports/financial-persistence.js';
import type { WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger-entry.js';
import { FinancialSession } from './financial-session.js';
import { LedgerEntryMapper, type LedgerEntryRecord } from './ledger-entry-mapper.js';

export class MikroLedgerEntryRepository implements LedgerEntryRepository {
  constructor(private readonly session: FinancialSession) {}

  async insert(entry: WalletLedgerEntry, walletVersion: number): Promise<void> {
    const r = LedgerEntryMapper.toRecord(entry, walletVersion);
    await this.session.execute(`INSERT INTO wallet_ledger_entries
      (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [r.id, r.wallet_id, r.transaction_id, r.wallet_version, r.direction, r.amount, r.currency,
      r.balance_before, r.balance_after, r.created_at]);
  }

  async listByWalletId(walletId: string): Promise<readonly PersistedLedgerEntry[]> {
    const rows = await this.session.execute<LedgerEntryRecord[]>(
      `SELECT id, wallet_id, transaction_id, wallet_version::text, direction, amount, currency,
        balance_before::text, balance_after::text, created_at FROM wallet_ledger_entries
        WHERE wallet_id = ? ORDER BY wallet_ledger_entries.wallet_version ASC, id ASC`, [walletId]);
    return Object.freeze(rows.map(row => LedgerEntryMapper.toDomain(row)));
  }
}
