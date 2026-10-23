import { expect, test } from 'bun:test';
import type { FinancialUnitOfWork } from '../../src/application/ports/financial-persistence.js';
import type { Wallet } from '../../src/domain/wallet/wallet.js';
import { Money } from '../../src/domain/money/money.js';
import { creator, fundedInput } from './wallet-creation-support.js';
import { processor, betTime } from './bet-processing-support.js';
import { withWagerDatabase, wagerInput, wagerState } from './wager-support.js';
import { assertReconciled, gate, bounded } from './bet-support.js';

const failures: readonly [string, string][] = [
  ...['wager_transactions', 'wallets', 'wallet_ledger_entries', 'outbox_messages', 'wager_transaction_results'].map(table => ['WIN', table] as [string, string]),
  ...['wager_transactions', 'outbox_messages', 'wager_transaction_results'].map(table => ['LOSS', table] as [string, string]),
  ...['wager_transactions', 'outbox_messages', 'wager_pending_receipts'].map(table => ['PENDING', table] as [string, string]),
];
test.each(failures)('%s rolls back all records on SQL write failure in %s', async (scenario, table) => {
  await withWagerDatabase(async ({ unit, app, owner }) => {
    const wallet = await creator(unit).execute(fundedInput), before = await wagerState(app);
    await owner.unsafe(`CREATE FUNCTION fail_wager_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'wager test fault' USING ERRCODE='P0001'; END $$`);
    await owner.unsafe(`CREATE TRIGGER fail_wager_write BEFORE ${table === 'wallets' ? 'UPDATE' : 'INSERT'} ON ${table}
      FOR EACH ROW ${scenario === 'WIN' && table === 'outbox_messages' ? "WHEN (NEW.event_type='WalletBalanceChanged')" : ''}
      EXECUTE FUNCTION fail_wager_write()`);
    const input = wagerInput(wallet.id, scenario === 'LOSS' ? 'LOSS' : 'WIN', scenario === 'PENDING' ? { referenceExternalTransactionId: 'missing' } : {});
    await expect(processor(unit).execute(input)).rejects.toHaveProperty('code', 'P0001');
    expect(await wagerState(app)).toEqual(before); await assertReconciled(app);
    await owner.unsafe('DROP FUNCTION fail_wager_write() CASCADE');
    expect(await processor(unit, 'fresh').execute(input)).toMatchObject({ status: scenario === 'PENDING' ? 'PENDING_REFERENCE' : 'PROCESSED',
      balance: { amount: scenario === 'WIN' ? '140.50' : '100.00' } });
    await assertReconciled(app);
  });
}, 20000);

test.each(['WIN', 'LOSS', 'PENDING'] as const)('%s cannot report success before deferred commit and never reuses mutated rollback state', async scenario => {
  await withWagerDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute(fundedInput), before = await wagerState(app), held = gate(), release = gate();
    let dirty: Wallet | undefined, success = false;
    const corrupt: FinancialUnitOfWork = { run: work => unit.run(async repos => {
      const result = await work(repos);
      dirty = (await repos.wallets.findByIdForUpdate(wallet.id))!;
      dirty.credit({ money: Money.from({ amount: '0.01', currency: 'BRL' }), transactionId: 'omitted', ledgerEntryId: 'omitted', at: betTime });
      await repos.wallets.save(dirty); held.open(); await release.ready; return result;
    }) };
    const input = wagerInput(wallet.id, scenario === 'LOSS' ? 'LOSS' : 'WIN', scenario === 'PENDING' ? { referenceExternalTransactionId: 'missing' } : {});
    const operation = processor(corrupt).execute(input).then(value => { success = true; return value; }, (error: unknown) => error);
    try {
      await bounded(held.ready); expect(success).toBe(false); expect(await wagerState(app)).toEqual(before);
      release.open(); expect(await bounded(operation)).toHaveProperty('code', '23514');
      expect(success).toBe(false); expect(await wagerState(app)).toEqual(before);
      await expect(unit.run(repos => repos.wallets.insert(dirty!))).rejects.toThrow('do not reuse an earlier instance');
      await processor(unit, 'fresh').execute(input); await assertReconciled(app);
    } finally { release.open(); await operation; }
  });
}, 20000);

test('WIN retry after a server serialization failure credits only once with fresh state', async () => {
  await withWagerDatabase(async ({ unit, app, owner }) => {
    const wallet = await creator(unit).execute(fundedInput);
    await owner`CREATE SEQUENCE win_attempts`; await owner`GRANT USAGE,SELECT ON SEQUENCE win_attempts TO wager_app`;
    await owner.unsafe(`CREATE FUNCTION retry_win() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF nextval('win_attempts')<2 THEN RAISE EXCEPTION 'injected serialization fault' USING ERRCODE='40001'; END IF;
      RETURN NEW; END $$`);
    await owner`CREATE TRIGGER retry_win BEFORE INSERT ON wager_transaction_results FOR EACH ROW EXECUTE FUNCTION retry_win()`;
    expect((await processor(unit).execute(wagerInput(wallet.id))).balance.amount).toBe('140.50');
    expect((await owner`SELECT last_value::text FROM win_attempts`)[0].last_value).toBe('2');
    expect((await app`SELECT count(*)::text n FROM wager_transactions WHERE kind='WIN'`)[0].n).toBe('1');
    expect((await app`SELECT version::text FROM wallets`)[0].version).toBe('2');
    await assertReconciled(app);
  });
}, 20000);
