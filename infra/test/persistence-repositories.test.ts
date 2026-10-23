import { expect, test } from 'bun:test';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction.js';
import { Money } from '../../src/domain/money/money.js';
import { Wallet } from '../../src/domain/wallet/wallet.js';
import { FinancialSession } from '../../src/infrastructure/persistence/financial/financial-session.js';
import type { FinancialRepositories } from '../../src/application/ports/financial-persistence.js';
import { inRepositoryTransaction, persistCredit, persistOpening, withPersistenceDatabase } from './persistence-support.js';

test('repositories share SQL transaction and preserve exact opening and ordered movements', async () => {
  await withPersistenceDatabase(async ({ appOrm, app }) => {
    await inRepositoryTransaction(appOrm, async (repos) => {
      const wallet = await persistOpening(repos);
      await persistCredit(repos, wallet, 'z-first', '0.10');
      await persistCredit(repos, wallet, 'a-second', '0.20');
    });
    await inRepositoryTransaction(appOrm, async (repos) => {
      const wallet = await repos.wallets.findById('wallet-1');
      expect(wallet?.balance.toJSON().amount).toBe('100.30');
      expect(wallet?.version).toBe(3);
      expect(wallet?.createdAt.toISOString()).toBe('2026-10-23T12:00:00.123Z');
      expect((await repos.wallets.findByPlayerAndCurrency('player-wallet-1', 'BRL'))?.id).toBe(wallet?.id);
      expect((await repos.transactions.findById('z-first'))?.status).toBe(WagerTransactionStatus.Processed);
      expect((await repos.transactions.findByExternalId('provider', 'z-first'))?.id).toBe('z-first');
      expect((await repos.transactions.findByIdempotencyKey('provider', 'z-first'))?.id).toBe('z-first');
      expect(await repos.transactions.findByExternalId('another-provider', 'z-first')).toBeNull();
      expect(await repos.transactions.findByIdempotencyKey('another-provider', 'z-first')).toBeNull();
      expect(await repos.wallets.findById("absent' OR TRUE --")).toBeNull();
      expect(await repos.wallets.findByIdForUpdate('absent')).toBeNull();
      expect(await repos.wallets.findByPlayerAndCurrency('missing', 'BRL')).toBeNull();
      expect(await repos.transactions.findById('missing')).toBeNull();
      expect(await repos.ledger.listByWalletId('missing')).toEqual([]);
      const entries = await repos.ledger.listByWalletId('wallet-1');
      expect(entries.map(({ walletVersion }) => walletVersion)).toEqual([1, 2, 3]);
      expect(entries.map(({ entry }) => entry.id)).toEqual(['entry-opening-wallet-1', 'entry-z-first', 'entry-a-second']);
      expect(Object.isFrozen(entries)).toBe(true);
    });
    expect((await app`SELECT current_user AS role`)[0].role).toBe('wager_app');
  });
}, 20_000);

test('wallet saves require fresh ownership, lock and exactly one movement', async () => {
  await withPersistenceDatabase(async ({ appOrm }) => {
    let old: Wallet | undefined;
    await inRepositoryTransaction(appOrm, async (repos) => { old = await persistOpening(repos); });
    await inRepositoryTransaction(appOrm, async (repos) => {
      await expect(repos.wallets.insert(old!)).rejects.toThrow('do not reuse');
      await expect(repos.wallets.save(old!)).rejects.toThrow('Load Wallet with a lock');
      const unlocked = (await repos.wallets.findById('wallet-1'))!;
      unlocked.credit({ ledgerEntryId: 'not-written', transactionId: 'not-written', money: Money.from({ amount: '1.00', currency: 'BRL' }), at: new Date() });
      await expect(repos.wallets.save(unlocked)).rejects.toThrow('Load Wallet with a lock');
      const locked = (await repos.wallets.findByIdForUpdate('wallet-1'))!;
      expect(locked).not.toBe(unlocked);
      expect(locked.balance.toJSON().amount).toBe('100.00');
      for (const id of ['one', 'two']) locked.credit({ ledgerEntryId: id, transactionId: id,
        money: Money.from({ amount: '1.00', currency: 'BRL' }), at: new Date() });
      await expect(repos.wallets.save(locked)).rejects.toThrow('each wallet movement');
    });
  });
}, 20_000);

test('repository scope expires and rejects nontransactional managers and reversed lock order', async () => {
  await withPersistenceDatabase(async ({ appOrm }) => {
    expect(() => new FinancialSession(appOrm.em.fork())).toThrow('outside a transaction');
    let escaped: FinancialRepositories | undefined;
    await inRepositoryTransaction(appOrm, async (repos) => {
      escaped = repos;
      await repos.wallets.findByIdForUpdate('z');
      await expect(repos.wallets.findByIdForUpdate('a')).rejects.toThrow('ascending');
    });
    await expect(escaped!.wallets.findById('wallet')).rejects.toThrow('closed');
  });
}, 20_000);

test('ledger order uses numeric version rather than textual 1,10,11,2 order', async () => {
  await withPersistenceDatabase(async ({ appOrm }) => {
    await inRepositoryTransaction(appOrm, async (repos) => {
      const wallet = await persistOpening(repos);
      for (let index = 1; index <= 11; index++) await persistCredit(repos, wallet, `win-${index}`);
    });
    await inRepositoryTransaction(appOrm, async (repos) => {
      expect((await repos.ledger.listByWalletId('wallet-1')).map(item => item.walletVersion))
        .toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    });
  });
}, 20_000);
