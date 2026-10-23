import { expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { Money } from '../../src/domain/money/money.js';
import { WagerTransaction, WagerTransactionKind } from '../../src/domain/wagering/wager-transaction.js';
import { MikroFinancialUnitOfWork } from '../../src/infrastructure/persistence/financial/financial-unit-of-work.js';
import { persistCredit, persistOpening, withPersistenceDatabase } from './persistence-support.js';

function gate(): { ready: Promise<void>; open: () => void } {
  let open!: () => void;
  const ready = new Promise<void>(resolve => { open = resolve; });
  return { ready, open };
}

async function within<T>(operation: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

async function observeBlockedWallet(sql: SQL): Promise<{ pid: number; blockers: number[] }> {
  const deadline = Date.now() + 4000;
  do {
    const rows = await sql`SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query LIKE '%FOR NO KEY UPDATE%' AND cardinality(pg_blocking_pids(pid)) > 0`;
    if (rows[0]) return rows[0] as { pid: number; blockers: number[] };
    // Polling cadence only: the assertion depends on observed server state, never elapsed delay.
    await Bun.sleep(10);
  } while (Date.now() < deadline);
  throw new Error('PostgreSQL did not report the expected blocked wallet session');
}

for (const ending of ['commit', 'rollback'] as const) {
  test(`independent sessions serialize wallet decisions and release locks after ${ending}`, async () => {
    await withPersistenceDatabase(async ({ appOrm, app }) => {
      const unit = new MikroFinancialUnitOfWork(appOrm);
      await unit.run(async repos => { await persistOpening(repos, 'wallet-a'); await persistOpening(repos, 'wallet-b'); });
      const held = gate();
      const release = gate();
      let beforeLock: string | undefined;
      let afterLock: string | undefined;
      let second: Promise<unknown> | undefined;
      let independent: Promise<unknown> | undefined;
      const first = unit.run(async repos => {
        const wallet = (await repos.wallets.findByIdForUpdate('wallet-a'))!;
        await persistCredit(repos, wallet, 'first', '10.00');
        held.open();
        await release.ready;
        if (ending === 'rollback') throw new Error('intentional rollback');
      }).then(() => null, (error: unknown) => error);
      try {
        await within(held.ready, 'first writer holds wallet lock');
        second = unit.run(async repos => {
          const stale = (await repos.wallets.findById('wallet-a'))!;
          beforeLock = stale.balance.toJSON().amount;
          // This FK takes KEY SHARE while writer one holds NO KEY UPDATE. It must coexist.
          await repos.transactions.insert(WagerTransaction.create({ id: 'fk-probe', providerId: 'provider',
            externalTransactionId: 'fk-probe', idempotencyKey: 'fk-probe', payloadHash: 'probe',
            walletId: stale.id, playerId: stale.playerId, roundId: 'round', gameId: 'game',
            kind: WagerTransactionKind.Bet, money: Money.from({ amount: '1.00', currency: 'BRL' }), createdAt: new Date() }));
          const fresh = (await repos.wallets.findByIdForUpdate('wallet-a'))!;
          expect(fresh).not.toBe(stale);
          afterLock = fresh.balance.toJSON().amount;
          await persistCredit(repos, fresh, 'second', '20.00');
        }).then(() => null, (error: unknown) => error);
        const blocked = await observeBlockedWallet(app);
        expect(blocked.blockers).toHaveLength(1);
        expect(blocked.blockers[0]).not.toBe(blocked.pid);
        expect(afterLock).toBeUndefined();
        independent = unit.run(async repos => {
          const wallet = (await repos.wallets.findByIdForUpdate('wallet-b'))!;
          await persistCredit(repos, wallet, 'independent', '30.00');
        }).then(() => null, (error: unknown) => error);
        expect(await within(independent, 'different wallet advances while first is locked')).toBeNull();
        expect((await app`SELECT balance::text AS balance FROM wallets WHERE id = 'wallet-b'`)[0].balance).toBe('130.00');
        release.open();
        const result = await within(first, 'first transaction finishes');
        if (ending === 'commit') expect(result).toBeNull();
        else expect(result).toHaveProperty('message', 'intentional rollback');
        expect(await within(second, 'second writer acquires released lock')).toBeNull();
        expect(beforeLock).toBe('100.00');
        expect(afterLock).toBe(ending === 'commit' ? '110.00' : '100.00');
        const [state] = await app`SELECT balance::text AS balance, version::text AS version FROM wallets WHERE id = 'wallet-a'`;
        expect(state).toEqual(ending === 'commit' ? { balance: '130.00', version: '3' } : { balance: '120.00', version: '2' });
        expect((await app`SELECT count(*)::text AS n FROM wager_transactions WHERE id = 'first'`)[0].n)
          .toBe(ending === 'commit' ? '1' : '0');
      } finally {
        release.open();
        await Promise.allSettled([first, second, independent].filter(item => item !== undefined));
      }
    });
  }, 30_000);
}
