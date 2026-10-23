import { expect, test } from 'bun:test';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction.js';
import { Money } from '../../src/domain/money/money.js';
import { withWagerDatabase } from './wager-support.js';
import { withFinancialDatabase, insertWallet, insertTransaction, expectSqlState } from './financial-schema-support.js';
import { creator, fundedInput } from './wallet-creation-support.js';
import { assertReconciled } from './bet-support.js';
import { betTime } from './bet-processing-support.js';

function transaction(walletId: string, kind: WagerTransactionKind, pending = false): WagerTransaction {
  return WagerTransaction.create({ id: 'operation', providerId: 'provider', externalTransactionId: 'external', idempotencyKey: 'key',
    payloadHash: 'hash', walletId, playerId: 'player', roundId: 'round', gameId: 'game', kind,
    money: Money.from({ amount: kind === WagerTransactionKind.Loss ? '0.00' : '40.50', currency: 'BRL' }),
    ...(pending ? { referenceExternalTransactionId: 'missing' } : {}), createdAt: betTime });
}

test('snapshot extension up down reapply preserves legacy BET data without invented results', async () => {
  await withFinancialDatabase('Migration20261023000004', async ({ orm, app }) => {
    await insertWallet(app); await insertTransaction(app, { status: 'REJECTED', failure: 'INSUFFICIENT_FUNDS' });
    await orm.migrator.up(); expect(await orm.migrator.up()).toEqual([]);
    expect((await app`SELECT count(*)::text n FROM wager_transaction_results`)[0].n).toBe('0');
    await orm.migrator.down({ to: 'Migration20261023000005' });
    expect((await app`SELECT to_regclass('wager_pending_receipts') name`)[0].name).toBeNull();
    expect((await app`SELECT status FROM wager_transactions`)[0].status).toBe('REJECTED');
    await orm.migrator.up(); await assertReconciled(app);
  });
}, 20000);

test.each([WagerTransactionKind.Win, WagerTransactionKind.Loss])('%s stores locked historical state with appropriate ledger requirement', async kind => {
  await withWagerDatabase(async ({ unit, app, orm }) => {
    const created = await creator(unit).execute(fundedInput);
    await unit.run(async repos => {
      const wallet = (await repos.wallets.findByIdForUpdate(created.id))!;
      const tx = transaction(wallet.id, kind); tx.markProcessed(undefined, betTime);
      await repos.transactions.insert(tx);
      if (kind === WagerTransactionKind.Win) {
        const movement = wallet.credit({ money: tx.money, transactionId: tx.id, ledgerEntryId: 'win-entry', at: betTime });
        await repos.wallets.save(wallet); await repos.ledger.insert(movement.entry, movement.walletVersion);
      }
      await repos.wagerResults.insert({ transactionId: tx.id, status: WagerTransactionStatus.Processed, balance: wallet.balance.toJSON() }, wallet.version);
    });
    expect(await unit.run(repos => repos.wagerResults.findByTransactionId('operation'))).toMatchObject({ status: 'PROCESSED', balance: {
      amount: kind === WagerTransactionKind.Win ? '140.50' : '100.00' } });
    expect((await app`SELECT wallet_version::text FROM wager_transaction_results`)[0].wallet_version).toBe(kind === WagerTransactionKind.Win ? '2' : '1');
    await expect(orm.migrator.down({ to: 'Migration20261023000005' })).rejects.toHaveProperty('code', '55000');
    await assertReconciled(app);
  });
}, 20000);

test('pending receipt is immutable, validated, unique and required at commit', async () => {
  await withWagerDatabase(async ({ unit, app, owner, orm }) => {
    const wallet = await creator(unit).execute(fundedInput);
    const receipt = { transactionId: 'operation', status: WagerTransactionStatus.PendingReference as const, balance: wallet.balance };
    await expect(unit.run(async repos => {
      const tx = transaction(wallet.id, WagerTransactionKind.Win, true); tx.markPendingReference();
      await repos.transactions.insert(tx);
    })).rejects.toHaveProperty('code', '23514');
    for (const version of [1, 2]) {
      const write = unit.run(async repos => {
        const tx = transaction(wallet.id, WagerTransactionKind.Win, true); tx.markPendingReference();
        await repos.transactions.insert(tx); await repos.wagerResults.insertPendingReceipt(receipt, version);
      });
      if (version === 1) await write;
      else await expect(write).rejects.toHaveProperty('code', '23505');
    }
    expect(await unit.run(repos => repos.wagerResults.findPendingReceipt('operation'))).toEqual(receipt);
    expect(await unit.run(repos => repos.wagerResults.findPendingReceipt('absent'))).toBeNull();
    await expect(unit.run(repos => repos.wagerResults.insertPendingReceipt(receipt, 2))).rejects.toHaveProperty('code', '23514');
    await expect(unit.run(repos => repos.wagerResults.insertPendingReceipt(receipt, 1))).rejects.toHaveProperty('code', '23505');
    for (const sql of ['UPDATE wager_pending_receipts SET schema_version=1', 'DELETE FROM wager_pending_receipts', 'TRUNCATE wager_pending_receipts']) {
      await expectSqlState(() => app.unsafe(sql), '42501'); await expectSqlState(() => owner.unsafe(sql), '23514');
    }
    await expect(orm.migrator.down({ to: 'Migration20261023000005' })).rejects.toHaveProperty('code', '55000');
    await assertReconciled(app);
  });
}, 20000);

test.each([WagerTransactionKind.Win, WagerTransactionKind.Loss])('%s terminal cannot commit without result', async kind => {
  await withWagerDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute(fundedInput);
    await expect(unit.run(async repos => {
      const tx = transaction(wallet.id, kind); tx.reject((await import('../../src/domain/wagering/failure-code.js')).FailureCode.DomainRuleViolation);
      await repos.transactions.insert(tx);
    })).rejects.toHaveProperty('code', '23514');
    expect((await app`SELECT count(*)::text n FROM wager_transactions WHERE kind=${kind}`)[0].n).toBe('0');
    await assertReconciled(app);
  });
}, 20000);

test('direct SQL cannot forge pending receipt shape identity currency balance or schema version', async () => {
  await withWagerDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute(fundedInput);
    const receipt = { transactionId: 'bad-receipt', status: 'PENDING_REFERENCE', balance: wallet.balance };
    const cases = [
      { version: 2, response: receipt },
      { version: 1, response: { ...receipt, transactionId: 'other' } },
      { version: 1, response: { ...receipt, status: 'PROCESSED' } },
      { version: 1, response: { ...receipt, failureCode: 'INVALID_REFERENCE' } },
      { version: 1, response: { ...receipt, balance: { amount: '100.00', currency: 'USD' } } },
      { version: 1, response: { ...receipt, balance: { amount: '101.00', currency: 'BRL' } } },
      { version: 1, response: { ...receipt, balance: { amount: '0100.00', currency: 'BRL' } } },
    ];
    for (const { version, response } of cases) {
      await expectSqlState(() => app.begin(async connection => {
        await insertTransaction(connection, { id: 'bad-receipt', kind: 'WIN', status: 'PENDING_REFERENCE',
          wallet: wallet.id, player: 'player', externalReference: 'absent' });
        await connection`INSERT INTO wager_pending_receipts VALUES ('bad-receipt',${version},1,${response})`;
      }), '23514');
    }
    expect(await app`SELECT * FROM wager_pending_receipts`).toEqual([]);
    expect(await app`SELECT id FROM wager_transactions WHERE id='bad-receipt'`).toEqual([]);
    await assertReconciled(app);
  });
}, 20000);
