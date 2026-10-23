import { expect, test } from 'bun:test';
import type { FinancialUnitOfWork } from '../../src/application/ports/financial-persistence.js';
import { ProcessWagerTransaction } from '../../src/application/wagering/process-wager-transaction.js';
import type { Wallet } from '../../src/domain/wallet/wallet.js';
import { Money } from '../../src/domain/money/money.js';
import { creator, fundedInput, sequenceIds } from './wallet-creation-support.js';
import { withBetDatabase, assertReconciled, gate, bounded } from './bet-support.js';
import { processor, betInput, databaseState, betTime } from './bet-processing-support.js';

test.each(['wager_transactions', 'wallets', 'wallet_ledger_entries', 'outbox_messages', 'wager_transaction_results'] as const)(
  'BET rolls back the entire operation when PostgreSQL fails writing %s', async table => {
    await withBetDatabase(async ({ unit, app, owner }) => {
      const wallet = await creator(unit).execute(fundedInput);
      const before = await databaseState(app);
      await owner.unsafe(`CREATE FUNCTION fail_bet_write() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'BET write fault' USING ERRCODE='P0001'; END $$`);
      await owner.unsafe(`CREATE TRIGGER fail_bet_write BEFORE ${table === 'wallets' ? 'UPDATE' : 'INSERT'} ON ${table}
        FOR EACH ROW ${table === 'outbox_messages' ? "WHEN (NEW.event_type='WalletBalanceChanged')" : ''}
        EXECUTE FUNCTION fail_bet_write()`);
      let attempts = 0;
      const counted: FinancialUnitOfWork = { run: work => { attempts++; return unit.run(work); } };
      const useCase = processor(counted);
      await expect(useCase.execute(betInput(wallet.id))).rejects.toHaveProperty('code', 'P0001');
      expect(attempts).toBe(1);
      expect(await databaseState(app)).toEqual(before);
      await assertReconciled(app);
      await owner.unsafe('DROP FUNCTION fail_bet_write() CASCADE');
      expect((await useCase.execute(betInput(wallet.id))).balance.amount).toBe('75.00');
      await assertReconciled(app);
    });
  }, 20_000,
);

test('BET cannot return success before commit and discards mutated Wallet after deferred failure', async () => {
  await withBetDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute(fundedInput);
    const before = await databaseState(app), held = gate(), release = gate();
    let dirty: Wallet | undefined, success = false;
    const corrupt: FinancialUnitOfWork = { run: work => unit.run(async repos => {
      const result = await work(repos);
      dirty = (await repos.wallets.findByIdForUpdate(wallet.id))!;
      dirty.debit({ money: Money.from({ amount: '0.01', currency: 'BRL' }), at: betTime,
        ledgerEntryId: 'omitted', transactionId: 'omitted' });
      await repos.wallets.save(dirty); // Existing deferred constraints must reject the omitted ledger at COMMIT.
      held.open(); await release.ready;
      return result;
    }) };
    const operation = processor(corrupt).execute(betInput(wallet.id))
      .then(value => { success = true; return value; }, (error: unknown) => error);
    try {
      await bounded(held.ready);
      expect(success).toBe(false); expect(await databaseState(app)).toEqual(before);
      release.open(); expect(await bounded(operation)).toHaveProperty('code', '23514');
      expect(success).toBe(false); expect(await databaseState(app)).toEqual(before);
      expect(dirty!.balance.toJSON().amount).toBe('74.99');
      await expect(unit.run(repos => repos.wallets.insert(dirty!))).rejects.toThrow('do not reuse an earlier instance');
      expect((await processor(unit, 'fresh').execute(betInput(wallet.id))).balance.amount).toBe('75.00');
      await assertReconciled(app);
    } finally { release.open(); await operation; }
  });
}, 20_000);

test.each(['40001', '40P01'] as const)('BET retries complete fresh transactions for SQLSTATE %s and commits only once', async sqlState => {
  await withBetDatabase(async ({ unit, app, owner }) => {
    const wallet = await creator(unit).execute(fundedInput);
    await owner`CREATE SEQUENCE bet_fault_attempts`;
    await owner`GRANT USAGE,SELECT ON SEQUENCE bet_fault_attempts TO wager_app`;
    // nextval is intentionally not rolled back: inject two server failures after the wallet UPDATE.
    await owner.unsafe(`CREATE FUNCTION retry_bet_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF nextval('bet_fault_attempts')<3 THEN RAISE EXCEPTION 'injected retryable SQLSTATE' USING ERRCODE='${sqlState}'; END IF;
      RETURN NEW; END $$`);
    await owner`CREATE TRIGGER retry_bet_write BEFORE INSERT ON wallet_ledger_entries FOR EACH ROW EXECUTE FUNCTION retry_bet_write()`;
    const result = await processor(unit).execute(betInput(wallet.id));
    expect(result).toMatchObject({ balance: { amount: '75.00' }, idempotentReplay: false });
    expect((await owner`SELECT last_value::text FROM bet_fault_attempts`)[0].last_value).toBe('3');
    expect((await app`SELECT count(*)::text AS n FROM wager_transactions WHERE kind='BET'`)[0].n).toBe('1');
    expect((await app`SELECT count(*)::text AS n FROM wallet_ledger_entries WHERE direction='DEBIT'`)[0].n).toBe('1');
    expect((await app`SELECT count(*)::text AS n FROM wager_transaction_results`)[0].n).toBe('1');
    expect((await app`SELECT count(*)::text AS n FROM outbox_messages WHERE payload->'data'->>'transactionId'=${result.transactionId}`)[0].n).toBe('2');
    await assertReconciled(app);
  });
}, 20_000);

test('BET stops after three retryable failures without storing FAILED or partial effects', async () => {
  await withBetDatabase(async ({ unit, app, owner }) => {
    const wallet = await creator(unit).execute(fundedInput);
    const before = await databaseState(app);
    await owner.unsafe(`CREATE FUNCTION retry_forever() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'retry exhausted' USING ERRCODE='40001'; END $$`);
    await owner`CREATE TRIGGER retry_forever BEFORE INSERT ON wallet_ledger_entries FOR EACH ROW EXECUTE FUNCTION retry_forever()`;
    let attempts = 0;
    const counted: FinancialUnitOfWork = { run: work => { attempts++; return unit.run(work); } };
    await expect(processor(counted).execute(betInput(wallet.id))).rejects.toHaveProperty('sqlState', '40001');
    expect(attempts).toBe(3); expect(await databaseState(app)).toEqual(before);
    await assertReconciled(app);
  });
}, 20_000);

test('unrelated unique violation is neither retried nor converted to a financial rejection', async () => {
  await withBetDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute(fundedInput);
    const before = await databaseState(app);
    let attempts = 0;
    const counted: FinancialUnitOfWork = { run: work => { attempts++; return unit.run(work); } };
    const unique = sequenceIds(); let n = 0;
    const useCase = new ProcessWagerTransaction(counted, { next: () => ++n >= 3 ? 'same-event' : unique.next() }, { now: () => betTime });
    await expect(useCase.execute(betInput(wallet.id))).rejects.toHaveProperty('constraint', 'outbox_messages_pkey');
    expect(attempts).toBe(1); expect(await databaseState(app)).toEqual(before);
    await assertReconciled(app);
  });
}, 20_000);

test('transaction composition shares the caller boundary and rollback includes the BET result', async () => {
  await withBetDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute(fundedInput), before = await databaseState(app);
    const useCase = processor(unit);
    await expect(unit.run(async repos => {
      expect((await useCase.processInTransaction(betInput(wallet.id), repos)).balance.amount).toBe('75.00');
      throw new Error('outer boundary aborted');
    })).rejects.toThrow('outer boundary aborted');
    expect(await databaseState(app)).toEqual(before);
    await assertReconciled(app);
  });
}, 20_000);
