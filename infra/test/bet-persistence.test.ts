import { expect, test } from 'bun:test';
import type { FinancialRepositories } from '../../src/application/ports/financial-persistence.js';
import type { WagerResultSnapshot } from '../../src/application/wagering/wager-result.js';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction.js';
import { FailureCode } from '../../src/domain/wagering/failure-code.js';
import { Money } from '../../src/domain/money/money.js';
import { creator, openingTime } from './wallet-creation-support.js';
import { insertWallet, insertTransaction, expectSqlState, withFinancialDatabase } from './financial-schema-support.js';
import { withBetDatabase, assertReconciled, gate, bounded, observeWait } from './bet-support.js';

function rejected(id: string, walletId: string): WagerTransaction {
  const tx = WagerTransaction.create({ id, providerId: 'p', externalTransactionId: id, idempotencyKey: id,
    payloadHash: 'hash', walletId, playerId: 'player', roundId: 'r', gameId: 'g', kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '1.00', currency: 'BRL' }), createdAt: new Date(openingTime) });
  tx.reject(FailureCode.InsufficientFunds);
  return tx;
}

test('result migration up down reapply preserves existing financial tables and never invents legacy results', async () => {
  await withFinancialDatabase('Migration20261023000004', async ({ orm, app }) => {
    await insertWallet(app);
    await insertTransaction(app, { status: 'REJECTED', failure: 'INSUFFICIENT_FUNDS' });
    await orm.migrator.up();
    expect(await orm.migrator.up()).toEqual([]);
    expect((await app`SELECT count(*)::text AS n FROM wager_transaction_results`)[0].n).toBe('0');
    expect((await app`SELECT status FROM wager_transactions`)[0].status).toBe('REJECTED');
    await orm.migrator.down({ to: 'Migration20261023000004' });
    expect((await app`SELECT to_regclass('public.wager_transaction_results') AS result`)[0].result).toBeNull();
    expect((await app`SELECT count(*)::text AS n FROM wallets`)[0].n).toBe('1');
    await orm.migrator.up();
    expect((await app`SELECT count(*)::text AS n FROM wager_transaction_results`)[0].n).toBe('0');
    await assertReconciled(app);
  });
}, 20_000);

test('result repository persists immutable rejected snapshot and validates currency amount status and version', async () => {
  await withBetDatabase(async ({ unit, app, owner }) => {
    const wallet = await creator(unit).execute({ playerId: 'player', initialBalance: { amount: '0.00', currency: 'BRL' } });
    const result: WagerResultSnapshot = { transactionId: 'bet', status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.InsufficientFunds, balance: { amount: '0.00', currency: 'BRL' } };
    await unit.run(async repos => {
      await repos.transactions.insert(rejected('bet', wallet.id));
      await repos.wagerResults.insert(result, 1);
    });
    const snapshot = await unit.run(repos => repos.wagerResults.findByTransactionId('bet'));
    expect(snapshot).toEqual(result); expect(Object.isFrozen(snapshot?.balance)).toBe(true);
    expect(await unit.run(repos => repos.wagerResults.findByTransactionId('missing'))).toBeNull();
    await expect(unit.run(repos => repos.wagerResults.insert(result, 1))).rejects.toHaveProperty('code', '23505');
    for (const mutation of ['UPDATE wager_transaction_results SET schema_version=1', 'DELETE FROM wager_transaction_results', 'TRUNCATE wager_transaction_results']) {
      await expectSqlState(() => app.unsafe(mutation), '42501');
      await expectSqlState(() => owner.unsafe(mutation), '23514');
    }
    for (const patch of [{ balance: { amount: '1.00', currency: 'BRL' } }, { balance: { amount: '0.00', currency: 'USD' } },
      { status: 'PROCESSED', failureCode: undefined }, { failureCode: 'DOMAIN_RULE_VIOLATION' }]) {
      await expect(unit.run(async repos => {
        await repos.transactions.insert(rejected('invalid', wallet.id));
        await repos.wagerResults.insert({ ...result, transactionId: 'invalid', ...patch } as typeof result, 1);
      })).rejects.toThrow();
    }
    await expect(unit.run(async repos => {
      await repos.transactions.insert(rejected('version', wallet.id));
      await repos.wagerResults.insert({ ...result, transactionId: 'version' }, 2);
    })).rejects.toHaveProperty('code', '23514');
    await assertReconciled(app);
  });
}, 20_000);

test('terminal BET without result fails at deferred commit and malformed SQL result is rejected', async () => {
  await withBetDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute({ playerId: 'player', initialBalance: { amount: '0.00', currency: 'BRL' } });
    let completed = false;
    await expect(unit.run(async repos => { await repos.transactions.insert(rejected('missing-result', wallet.id)); completed = true; }))
      .rejects.toHaveProperty('code', '23514');
    expect(completed).toBe(true);
    expect((await app`SELECT count(*)::text AS n FROM wager_transactions`)[0].n).toBe('0');
    for (const response of [{}, { transactionId: 'missing', status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: 0, currency: 'BRL' } },
      { transactionId: 'missing', status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '0.001', currency: 'BRL' } }]) {
      await expectSqlState(() => app`INSERT INTO wager_transaction_results VALUES ('missing',1,1,${response})`, '23514');
    }
    await assertReconciled(app);
  });
}, 20_000);

test.each(['key', 'external'] as const)('admission lock serializes %s identity and releases on rollback without global blocking', async identity => {
  await withBetDatabase(async ({ unit, app }) => {
    const held = gate(), release = gate();
    let second: Promise<unknown> | undefined;
    const first = unit.run(async repos => {
      await repos.wagerAdmission.lock('p', 'key', 'external'); held.open(); await release.ready; throw new Error('rollback lock');
    }).catch((error: unknown) => error);
    try {
      await bounded(held.ready);
      second = unit.run(async repos => {
        await repos.wagerAdmission.lock('p', identity === 'key' ? 'key' : 'other', identity === 'external' ? 'external' : 'other');
        return 'acquired';
      });
      await observeWait(app, 'pg_advisory_xact_lock');
      expect(await bounded(unit.run(async repos => { await repos.wagerAdmission.lock('other-provider', 'key', 'external'); return 'independent'; })))
        .toBe('independent');
      release.open(); await bounded(first); expect(await bounded(second)).toBe('acquired');
      await assertReconciled(app);
    } finally { release.open(); await Promise.allSettled([first, second]); }
  });
}, 20_000);

test('admission guard rejects repeat late or expired use of repositories', async () => {
  await withBetDatabase(async ({ unit, app }) => {
    let escaped: FinancialRepositories | undefined;
    await unit.run(async repos => { escaped = repos; await repos.wagerAdmission.lock('p', 'k', 'e'); });
    await expect(escaped!.wagerAdmission.lock('p', 'k', 'e')).rejects.toThrow('closed');
    await expect(unit.run(async repos => { await repos.wagerAdmission.lock('p', 'k', 'e'); await repos.wagerAdmission.lock('p', 'k2', 'e2'); }))
      .rejects.toThrow('Admit one wager');
    await expect(unit.run(async repos => { await repos.wallets.findByIdForUpdate('any'); await repos.wagerAdmission.lock('p', 'k', 'e'); }))
      .rejects.toThrow('Admit one wager');
    await assertReconciled(app);
  });
}, 20_000);
