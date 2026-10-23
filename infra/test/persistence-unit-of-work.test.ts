import { expect, test } from 'bun:test';
import { Money } from '../../src/domain/money/money.js';
import { Wallet } from '../../src/domain/wallet/wallet.js';
import type { FinancialRepositories } from '../../src/application/ports/financial-persistence.js';
import { MikroFinancialUnitOfWork } from '../../src/infrastructure/persistence/financial/financial-unit-of-work.js';
import { persistCredit, persistOpening, withPersistenceDatabase } from './persistence-support.js';

test('financial boundary confirms opening together and returns only after commit', async () => {
  await withPersistenceDatabase(async ({ appOrm, app }) => {
    const unit = new MikroFinancialUnitOfWork(appOrm);
    const id = await unit.run(async repos => (await persistOpening(repos)).id);
    expect(id).toBe('wallet-1');
    const [counts] = await app`SELECT (SELECT count(*)::text FROM wallets) AS wallets,
      (SELECT count(*)::text FROM wager_transactions) AS transactions,
      (SELECT count(*)::text FROM wallet_ledger_entries) AS entries`;
    expect(counts).toEqual({ wallets: '1', transactions: '1', entries: '1' });
  });
}, 20_000);

test('explicit callback error rolls back all opening records', async () => {
  await withPersistenceDatabase(async ({ appOrm, app }) => {
    const unit = new MikroFinancialUnitOfWork(appOrm);
    await expect(unit.run(async repos => {
      await persistOpening(repos);
      throw new Error('forced before commit');
    })).rejects.toThrow('forced before commit');
    const [counts] = await app`SELECT (SELECT count(*)::text FROM wallets) AS wallets,
      (SELECT count(*)::text FROM wager_transactions) AS transactions,
      (SELECT count(*)::text FROM wallet_ledger_entries) AS entries`;
    expect(counts).toEqual({ wallets: '0', transactions: '0', entries: '0' });
  });
}, 20_000);

test('deferred commit failure rejects a completed callback and rolls back every write', async () => {
  await withPersistenceDatabase(async ({ appOrm, app }) => {
    const unit = new MikroFinancialUnitOfWork(appOrm);
    let callbackCompleted = false;
    await expect(unit.run(async repos => {
      await persistOpening(repos, 'valid');
      const { wallet } = Wallet.open({ id: 'missing-ledger', playerId: 'player-missing',
        initialBalance: Money.from({ amount: '1.00', currency: 'BRL' }), at: new Date(),
        opening: { transactionId: 'missing', ledgerEntryId: 'missing' } });
      await repos.wallets.insert(wallet);
      callbackCompleted = true;
      return 'must not escape as success';
    })).rejects.toHaveProperty('code', '23514');
    expect(callbackCompleted).toBe(true);
    expect((await app`SELECT count(*)::text AS n FROM wallets`)[0].n).toBe('0');
    expect((await app`SELECT count(*)::text AS n FROM wager_transactions`)[0].n).toBe('0');
    expect((await app`SELECT count(*)::text AS n FROM wallet_ledger_entries`)[0].n).toBe('0');
  });
}, 20_000);

test('rollback leaves JavaScript mutated but forbids reuse and reloads persisted wallet', async () => {
  await withPersistenceDatabase(async ({ appOrm }) => {
    const unit = new MikroFinancialUnitOfWork(appOrm);
    await unit.run(async repos => { await persistOpening(repos); });
    let dirty: Wallet | undefined;
    let escaped: FinancialRepositories | undefined;
    await expect(unit.run(async repos => {
      escaped = repos;
      dirty = (await repos.wallets.findByIdForUpdate('wallet-1'))!;
      await persistCredit(repos, dirty, 'rolled-back', '10.00');
      throw new Error('rollback mutation');
    })).rejects.toThrow('rollback mutation');
    expect(dirty?.balance.toJSON().amount).toBe('110.00');
    await expect(escaped!.wallets.findById('wallet-1')).rejects.toThrow('closed');
    await unit.run(async repos => {
      await expect(repos.wallets.save(dirty!)).rejects.toThrow('Load Wallet with a lock');
      await expect(repos.wallets.insert(dirty!)).rejects.toThrow('do not reuse');
      const fresh = (await repos.wallets.findByIdForUpdate('wallet-1'))!;
      expect(fresh).not.toBe(dirty);
      expect(fresh.balance.toJSON().amount).toBe('100.00');
      expect(fresh.version).toBe(1);
      expect(await repos.transactions.findById('rolled-back')).toBeNull();
      expect(await repos.ledger.listByWalletId('wallet-1')).toHaveLength(1);
      await persistCredit(repos, fresh, 'after-rollback', '0.10');
    });
  });
}, 20_000);

test('nested financial boundaries fail and leave the outer scope usable', async () => {
  await withPersistenceDatabase(async ({ appOrm }) => {
    const unit = new MikroFinancialUnitOfWork(appOrm);
    await unit.run(async repos => {
      await expect(unit.run(async () => 'nested')).rejects.toThrow('Nested financial units');
      await persistOpening(repos);
    });
    expect(await unit.run(async repos => (await repos.wallets.findById('wallet-1'))?.version)).toBe(1);
  });
}, 20_000);

test('application adapter role cannot run DDL or mutate ledger and constraints stay enabled', async () => {
  await withPersistenceDatabase(async ({ appOrm, owner }) => {
    const unit = new MikroFinancialUnitOfWork(appOrm);
    await unit.run(async repos => { await persistOpening(repos); });
    const em = appOrm.em.fork();
    expect((await em.execute<{ role: string }[]>('SELECT current_user AS role'))[0]?.role).toBe('wager_app');
    for (const sql of [
      'CREATE TABLE forbidden_migration (id text)',
      "UPDATE wallet_ledger_entries SET amount = amount WHERE id = 'entry-opening-wallet-1'",
      "DELETE FROM wallet_ledger_entries WHERE id = 'entry-opening-wallet-1'",
      'ALTER TABLE wallets DISABLE TRIGGER ALL',
      "SET session_replication_role = 'replica'",
    ]) await expect(em.execute(sql)).rejects.toHaveProperty('code', '42501');
    const triggers = await owner`SELECT tgname, tgenabled, tgdeferrable, tginitdeferred FROM pg_trigger
      WHERE tgname IN ('wallet_movement_consistency','transaction_ledger_consistency','ledger_entry_consistency')`;
    expect(triggers).toHaveLength(3);
    for (const trigger of triggers) {
      expect(trigger.tgenabled).toBe('O');
      expect(trigger.tgdeferrable).toBe(true);
      expect(trigger.tginitdeferred).toBe(true);
    }
  });
}, 20_000);

test('zero opening needs neither financial transaction nor ledger', async () => {
  await withPersistenceDatabase(async ({ appOrm, app }) => {
    const unit = new MikroFinancialUnitOfWork(appOrm);
    await unit.run(async repos => {
      const { wallet, openingEntry } = Wallet.open({ id: 'empty', playerId: 'player-empty',
        initialBalance: Money.zero('BRL'), at: new Date() });
      expect(openingEntry).toBeNull();
      await repos.wallets.insert(wallet);
    });
    expect((await app`SELECT balance::text AS balance, version::text AS version FROM wallets`)[0])
      .toEqual({ balance: '0.00', version: '1' });
    expect((await app`SELECT count(*)::text AS n FROM wallet_ledger_entries`)[0].n).toBe('0');
    expect((await app`SELECT count(*)::text AS n FROM wager_transactions`)[0].n).toBe('0');
  });
}, 20_000);
