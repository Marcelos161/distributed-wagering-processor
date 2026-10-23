import { expect, test } from 'bun:test';
import type { FinancialUnitOfWork } from '../../src/application/ports/financial-persistence.js';
import type { Wallet } from '../../src/domain/wallet/wallet.js';
import { Money } from '../../src/domain/money/money.js';
import { creator, fundedInput } from './wallet-creation-support.js';
import { processor, betInput, betTime } from './bet-processing-support.js';
import { withRefundDatabase, refundInput } from './refund-support.js';
import { wagerState } from './wager-support.js';
import { assertReconciled, gate, bounded } from './bet-support.js';

const failures: readonly [string, string][] = [
  ...['wager_transactions', 'wallets', 'wallet_ledger_entries', 'outbox_messages', 'wager_transaction_results'].map(table => ['PROCESSED', table] as [string, string]),
  ...['wager_transactions', 'outbox_messages', 'wager_pending_receipts'].map(table => ['PENDING', table] as [string, string]),
  ...['outbox_messages', 'wager_transaction_results'].map(table => ['REJECTED', table] as [string, string]),
];
test.each(failures)('REFUND %s rolls back all records on PostgreSQL failure writing %s', async (scenario, table) => {
  await withRefundDatabase(async ({ unit, app, owner }) => {
    const wallet = await creator(unit).execute(fundedInput), setup = processor(unit, 'setup');
    if (scenario !== 'PENDING') await setup.execute(betInput(wallet.id));
    if (scenario === 'REJECTED') await setup.execute(refundInput(wallet.id));
    const input = refundInput(wallet.id, { externalTransactionId: 'attempt', idempotencyKey: 'attempt' }), before = await wagerState(app);
    await owner.unsafe(`CREATE FUNCTION fail_refund_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'REFUND write fault' USING ERRCODE='P0001'; END $$`);
    await owner.unsafe(`CREATE TRIGGER fail_refund_write BEFORE ${table === 'wallets' ? 'UPDATE' : 'INSERT'} ON ${table}
      FOR EACH ROW ${scenario === 'PROCESSED' && table === 'outbox_messages' ? "WHEN (NEW.event_type='WalletBalanceChanged')" : ''}
      EXECUTE FUNCTION fail_refund_write()`);
    let attempts = 0;
    const counted: FinancialUnitOfWork = { run: work => { attempts++; return unit.run(work); } };
    await expect(processor(counted).execute(input)).rejects.toHaveProperty('code', 'P0001');
    expect(attempts).toBe(1); expect(await wagerState(app)).toEqual(before); await assertReconciled(app);
    await owner.unsafe('DROP FUNCTION fail_refund_write() CASCADE');
    expect(await processor(unit, 'fresh').execute(input)).toMatchObject({ status: scenario === 'PENDING' ? 'PENDING_REFERENCE' : scenario,
      balance: { amount: '100.00' } });
    await assertReconciled(app);
  });
}, 20000);

test.each(['PROCESSED', 'PENDING', 'REJECTED'] as const)('REFUND %s waits for deferred commit and discards rolled-back objects', async scenario => {
  await withRefundDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute(fundedInput), setup = processor(unit, 'setup');
    if (scenario !== 'PENDING') await setup.execute(betInput(wallet.id));
    if (scenario === 'REJECTED') await setup.execute(refundInput(wallet.id));
    const before = await wagerState(app), held = gate(), release = gate();
    let dirty: Wallet | undefined, returned = false;
    const corrupt: FinancialUnitOfWork = { run: work => unit.run(async repos => {
      const result = await work(repos);
      dirty = (await repos.wallets.findByIdForUpdate(wallet.id))!;
      dirty.credit({ money: Money.from({ amount: '0.01', currency: 'BRL' }), transactionId: 'omitted', ledgerEntryId: 'omitted', at: betTime });
      await repos.wallets.save(dirty); held.open(); await release.ready; return result;
    }) };
    const input = refundInput(wallet.id, { externalTransactionId: 'attempt', idempotencyKey: 'attempt' });
    const operation = processor(corrupt).execute(input).then(value => { returned = true; return value; }, (error: unknown) => error);
    try {
      await bounded(held.ready); expect(returned).toBe(false); expect(await wagerState(app)).toEqual(before);
      release.open(); expect(await bounded(operation)).toHaveProperty('code', '23514');
      expect(returned).toBe(false); expect(await wagerState(app)).toEqual(before);
      await expect(unit.run(repos => repos.wallets.insert(dirty!))).rejects.toThrow('do not reuse an earlier instance');
      await processor(unit, 'fresh').execute(input); await assertReconciled(app);
    } finally { release.open(); await operation; }
  });
}, 20000);

test('REFUND retries a full fresh transaction after a server serialization failure, without duplicating the credit', async () => {
  await withRefundDatabase(async ({ unit, app, owner }) => {
    const wallet = await creator(unit).execute(fundedInput); await processor(unit, 'setup').execute(betInput(wallet.id));
    await owner`CREATE SEQUENCE refund_attempts`; await owner`GRANT USAGE,SELECT ON SEQUENCE refund_attempts TO wager_app`;
    await owner.unsafe(`CREATE FUNCTION retry_refund() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF nextval('refund_attempts')<2 THEN RAISE EXCEPTION 'injected serialization fault' USING ERRCODE='40001'; END IF;
      RETURN NEW; END $$`);
    await owner`CREATE TRIGGER retry_refund BEFORE INSERT ON wager_transaction_results FOR EACH ROW EXECUTE FUNCTION retry_refund()`;
    expect((await processor(unit).execute(refundInput(wallet.id))).balance.amount).toBe('100.00');
    expect((await owner`SELECT last_value::text FROM refund_attempts`)[0].last_value).toBe('2');
    expect((await app`SELECT count(*)::text n FROM wager_transactions WHERE kind='REFUND'`)[0].n).toBe('1');
    expect((await app`SELECT version::text FROM wallets`)[0].version).toBe('3'); await assertReconciled(app);
  });
}, 20000);

test('REFUND processInTransaction participates in the caller rollback including response and events', async () => {
  await withRefundDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute(fundedInput); await processor(unit, 'setup').execute(betInput(wallet.id));
    const before = await wagerState(app), useCase = processor(unit);
    await expect(unit.run(async repos => {
      expect((await useCase.processInTransaction(refundInput(wallet.id), repos)).balance.amount).toBe('100.00');
      throw new Error('outer boundary failed');
    })).rejects.toThrow('outer boundary failed');
    expect(await wagerState(app)).toEqual(before); await assertReconciled(app);
  });
}, 20000);
