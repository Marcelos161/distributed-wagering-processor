import { expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmOptions } from '../../src/infrastructure/persistence/orm-options.js';
import { WalletMapper, type WalletRecord } from '../../src/infrastructure/persistence/financial/wallet-mapper.js';
import { WagerTransactionMapper, type WagerTransactionRecord } from '../../src/infrastructure/persistence/financial/wager-transaction-mapper.js';
import { LedgerEntryMapper, type LedgerEntryRecord } from '../../src/infrastructure/persistence/financial/ledger-entry-mapper.js';
import { insertLedger, insertTransaction, insertWallet, withFinancialDatabase } from './financial-schema-support.js';

test('real application driver roundtrips exact financial snapshots without replay', async () => {
  await withFinancialDatabase('Migration20261023000003', async ({ app, applicationUrl }) => {
    await app.begin(async (sql) => {
      await insertWallet(sql, 'wallet-1', '999999999999999999.99');
      await insertTransaction(sql, { id: 'opening', kind: 'OPENING', amount: '999999999999999999.99', status: 'PROCESSED' });
      await insertLedger(sql, { id: 'opening-entry', transaction: 'opening', version: 1,
        amount: '999999999999999999.99', before: '0.00', after: '999999999999999999.99' });
      await insertTransaction(sql, { id: 'waiting', kind: 'WIN', amount: '0.10', status: 'PENDING_REFERENCE', externalReference: 'future-bet' });
    });
    const orm = await MikroORM.init(createOrmOptions(applicationUrl));
    try {
      const em = orm.em.fork();
      const [wallet] = await em.execute<WalletRecord[]>('SELECT *, version::text FROM wallets');
      expect(wallet).toBeDefined();
      expect(WalletMapper.toRecord(WalletMapper.toDomain(wallet!))).toEqual({ ...wallet!, created_at: new Date('2026-10-23T12:00:00Z'), updated_at: new Date('2026-10-23T12:00:00Z') });
      for (const row of await em.execute<WagerTransactionRecord[]>('SELECT * FROM wager_transactions')) {
        expect(WagerTransactionMapper.toRecord(WagerTransactionMapper.toDomain(row))).toEqual({ ...row, created_at: new Date('2026-10-23T12:00:00Z'), processed_at: row.processed_at === null ? null : new Date('2026-10-23T12:01:00Z') });
      }
      const [entry] = await em.execute<LedgerEntryRecord[]>('SELECT *, wallet_version::text FROM wallet_ledger_entries');
      const mapped = LedgerEntryMapper.toDomain(entry!);
      expect(LedgerEntryMapper.toRecord(mapped.entry, mapped.walletVersion)).toEqual({ ...entry!, created_at: new Date('2026-10-23T12:01:00Z') });
      expect((await app`SELECT count(*)::text AS n FROM wallet_ledger_entries`)[0].n).toBe('1');
    } finally { await orm.close(); }
  });
}, 20_000);

test('processed reference and terminal failures survive PostgreSQL rehydration', async () => {
  await withFinancialDatabase('Migration20261023000003', async ({ app, applicationUrl }) => {
    await app.begin(async (sql) => {
      await insertWallet(sql);
      await insertTransaction(sql, { id: 'win', kind: 'WIN', amount: '1.00', status: 'PROCESSED' });
      await sql`UPDATE wallets SET balance = '1.00', version = 2 WHERE id = 'wallet-1'`;
      await insertLedger(sql, { transaction: 'win', amount: '1.00', before: '0.00', after: '1.00' });
      await insertTransaction(sql, { id: 'bet', amount: '0.30', status: 'PROCESSED' });
      await sql`UPDATE wallets SET balance = '0.70', version = 3 WHERE id = 'wallet-1'`;
      await insertLedger(sql, { id: 'bet-entry', transaction: 'bet', version: 3, direction: 'DEBIT',
        amount: '0.30', before: '1.00', after: '0.70' });
      await insertTransaction(sql, { id: 'prize', kind: 'WIN', amount: '0.10', status: 'PROCESSED', externalReference: 'bet', reference: 'bet' });
      await sql`UPDATE wallets SET balance = '0.80', version = 4 WHERE id = 'wallet-1'`;
      await insertLedger(sql, { id: 'prize-entry', transaction: 'prize', version: 4,
        amount: '0.10', before: '0.70', after: '0.80' });
      await insertTransaction(sql, { id: 'rejected', status: 'REJECTED', failure: 'INSUFFICIENT_FUNDS' });
      await insertTransaction(sql, { id: 'failed', status: 'FAILED', failure: 'PERMANENT_INFRASTRUCTURE_FAILURE' });
    });
    const orm = await MikroORM.init(createOrmOptions(applicationUrl));
    try {
      const rows = await orm.em.fork().execute<WagerTransactionRecord[]>('SELECT * FROM wager_transactions ORDER BY id');
      for (const row of rows) {
        const result = WagerTransactionMapper.toRecord(WagerTransactionMapper.toDomain(row));
        expect(result).toEqual({ ...row, created_at: new Date('2026-10-23T12:00:00Z'),
          processed_at: row.processed_at === null ? null : new Date('2026-10-23T12:01:00Z') });
      }
      expect(rows.find(row => row.id === 'prize')?.reference_transaction_id).toBe('bet');
      expect((await app`SELECT balance::text AS balance, version::text AS version FROM wallets`)[0])
        .toEqual({ balance: '0.80', version: '4' });
    } finally { await orm.close(); }
  });
}, 20_000);
