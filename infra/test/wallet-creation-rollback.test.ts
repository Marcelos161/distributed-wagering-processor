import { expect, spyOn, test } from 'bun:test';
import type { FinancialUnitOfWork } from '../../src/application/ports/financial-persistence.js';
import { CreateWallet } from '../../src/application/wallet/create-wallet.js';
import { Money } from '../../src/domain/money/money.js';
import type { Wallet } from '../../src/domain/wallet/wallet.js';
import { WagerTransaction } from '../../src/domain/wagering/wager-transaction.js';
import { withMessagingDatabase } from './messaging-support.js';
import { creator, expectCounts, fundedInput, openingTime } from './wallet-creation-support.js';

test('CreateWallet rolls back a real wallet INSERT when the OPENING factory throws', async () => {
  await withMessagingDatabase(async ({ unit, app }) => {
    let inserted = false;
    const observed: FinancialUnitOfWork = { run: work => unit.run(repos => work({ ...repos,
      wallets: { ...repos.wallets,
        findById: id => repos.wallets.findById(id),
        findByPlayerAndCurrency: (id, currency) => repos.wallets.findByPlayerAndCurrency(id, currency),
        findByIdForUpdate: id => repos.wallets.findByIdForUpdate(id),
        save: wallet => repos.wallets.save(wallet),
        insert: async wallet => { await repos.wallets.insert(wallet); inserted = true; },
      },
    })) };
    const useCase = creator(observed);
    const fault = spyOn(WagerTransaction, 'createOpening').mockImplementationOnce(() => { throw new Error('injected factory failure'); });
    try {
      await expect(useCase.execute(fundedInput)).rejects.toThrow('injected factory failure');
      expect(inserted).toBe(true);
      await expectCounts(app, '0', '0', '0', '0');
    } finally { fault.mockRestore(); }
    expect((await useCase.execute(fundedInput)).version).toBe(1);
    await expectCounts(app, '1', '1', '1', '2');
  });
}, 20_000);

test.each(['wager_transactions', 'wallet_ledger_entries', 'outbox_messages'] as const)(
  'CreateWallet rolls back a PostgreSQL write failure in %s', async table => {
    await withMessagingDatabase(async ({ unit, app, owner }) => {
      await owner.unsafe(`CREATE FUNCTION fail_creation_write() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected SQL write failure' USING ERRCODE='P0001'; END $$`);
      // All identifiers below are literals from this test; the Outbox fails on its SECOND insert.
      await owner.unsafe(`CREATE TRIGGER fail_creation_write BEFORE INSERT ON ${table}
        FOR EACH ROW ${table === 'outbox_messages' ? "WHEN (NEW.id='case-5')" : ''}
        EXECUTE FUNCTION fail_creation_write()`);
      const useCase = creator(unit);
      await expect(useCase.execute(fundedInput)).rejects.toHaveProperty('code', 'P0001');
      await expectCounts(app, '0', '0', '0', '0');
      await owner.unsafe('DROP FUNCTION fail_creation_write() CASCADE');
      const response = await useCase.execute(fundedInput);
      expect(response.id).not.toBe('case-1');
      expect(response.version).toBe(1);
      await expectCounts(app, '1', '1', '1', '2');
    });
  }, 20_000,
);

test('CreateWallet propagates Outbox identity collisions rather than wallet conflicts', async () => {
  await withMessagingDatabase(async ({ unit, app }) => {
    const ids = ['wallet', 'opening', 'ledger', 'same-event', 'same-event'];
    const useCase = new CreateWallet(unit, { next: () => ids.shift()! }, { now: () => new Date(openingTime) });
    await expect(useCase.execute(fundedInput)).rejects.toHaveProperty('constraint', 'outbox_messages_pkey');
    await expectCounts(app, '0', '0', '0', '0');
  });
}, 20_000);

test('CreateWallet rejects a deferred commit failure and discards mutated objects before retry', async () => {
  await withMessagingDatabase(async ({ unit, app }) => {
    let inject = true;
    let callbackCompleted = false;
    let dirtyWallet: Wallet | undefined;
    const observed: FinancialUnitOfWork = { run: work => unit.run(async repos => {
      const result = await work(repos);
      if (inject) {
        dirtyWallet = (await repos.wallets.findByIdForUpdate('case-1'))!;
        // Real domain transition + SQL UPDATE, deliberately omit its ledger: the EXISTING
        // deferred constraint must reject COMMIT, after the use case callback completed.
        dirtyWallet.credit({ money: Money.from({ amount: '1.00', currency: 'BRL' }),
          ledgerEntryId: 'omitted-ledger', transactionId: 'omitted-transaction', at: new Date(openingTime) });
        await repos.wallets.save(dirtyWallet);
        callbackCompleted = true;
      }
      return result;
    }) };
    const useCase = creator(observed);
    let success = false;
    const result = useCase.execute(fundedInput).then(value => { success = true; return value; });
    await expect(result).rejects.toHaveProperty('code', '23514');
    expect(callbackCompleted).toBe(true);
    expect(success).toBe(false);
    await expectCounts(app, '0', '0', '0', '0');
    expect(dirtyWallet!.balance.toJSON().amount).toBe('101.00'); // SQL rollback does not undo JS memory.
    await expect(unit.run(repos => repos.wallets.insert(dirtyWallet!))).rejects.toThrow('do not reuse an earlier instance');
    inject = false;
    const response = await useCase.execute(fundedInput);
    expect(response).toMatchObject({ id: 'case-6', balance: fundedInput.initialBalance, version: 1 });
    await expectCounts(app, '1', '1', '1', '2');
  });
}, 20_000);
