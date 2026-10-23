import { expect, test } from 'bun:test';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction.js';
import { FailureCode } from '../../src/domain/wagering/failure-code.js';
import { Money } from '../../src/domain/money/money.js';
import { withRefundDatabase, refundInput } from './refund-support.js';
import { withFinancialDatabase } from './financial-schema-support.js';
import { creator, fundedInput } from './wallet-creation-support.js';
import { betInput, processor, betTime } from './bet-processing-support.js';
import { assertReconciled } from './bet-support.js';
import { wagerState } from './wager-support.js';
import { createOrmOptions } from '../../src/infrastructure/persistence/orm-options.js';
import { MikroORM } from '@mikro-orm/postgresql';
import { MikroFinancialUnitOfWork } from '../../src/infrastructure/persistence/financial/financial-unit-of-work.js';

function refund(walletId: string, id = 'refund'): WagerTransaction {
  return WagerTransaction.create({ ...refundInput(walletId), id, externalTransactionId: id, idempotencyKey: id,
    kind: WagerTransactionKind.Refund, money: Money.from({ amount: '25.00', currency: 'BRL' }), createdAt: betTime, payloadHash: 'hash' });
}
test('REFUND migration up down reapply preserves existing WIN pending and BET historical records', async () => {
  await withFinancialDatabase('Migration20261023000006', async ({ orm, app, applicationUrl }) => {
    const appOrm = await MikroORM.init(createOrmOptions(applicationUrl));
    try {
      const unit = new MikroFinancialUnitOfWork(appOrm), wallet = await creator(unit).execute(fundedInput);
      await processor(unit).execute(betInput(wallet.id));
      await processor(unit, 'pending').execute({ ...refundInput(wallet.id), kind: 'WIN', referenceExternalTransactionId: 'absent' });
      const before = await wagerState(app);
      await orm.migrator.up(); expect(await orm.migrator.up()).toEqual([]);
      expect(await wagerState(app)).toEqual(before);
      await orm.migrator.down({ to: 'Migration20261023000006' }); expect(await wagerState(app)).toEqual(before);
      await orm.migrator.up(); expect(await wagerState(app)).toEqual(before); await assertReconciled(app);
    } finally { await appOrm.close(); }
  });
}, 20000);

test('processed refund lookup ignores pending and rejected attempts; unique index rejects a second processed refund', async () => {
  await withRefundDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute(fundedInput);
    const bet = await processor(unit).execute(betInput(wallet.id));
    await unit.run(async repos => {
      await repos.transactions.insert(refund(wallet.id, 'pending'));
      const rejected = refund(wallet.id, 'rejected'); rejected.reject(FailureCode.InvalidReference);
      await repos.transactions.insert(rejected);
      await repos.wagerResults.insert({ transactionId: rejected.id, status: WagerTransactionStatus.Rejected,
        failureCode: FailureCode.InvalidReference, balance: { amount: '75.00', currency: 'BRL' } }, 2);
      expect(await repos.transactions.findProcessedRefund(bet.transactionId)).toBeNull();
      const tx = refund(wallet.id), reference = (await repos.transactions.findById(bet.transactionId))!;
      const locked = (await repos.wallets.findByIdForUpdate(wallet.id))!;
      tx.assertRefundAvailable(reference, null); tx.markProcessed(reference, betTime);
      const movement = locked.credit({ money: tx.money, ledgerEntryId: 'refund-entry', transactionId: tx.id, at: betTime });
      await repos.transactions.insert(tx); await repos.wallets.save(locked); await repos.ledger.insert(movement.entry, movement.walletVersion);
      await repos.wagerResults.insert({ transactionId: tx.id, status: WagerTransactionStatus.Processed, balance: locked.balance.toJSON() }, locked.version);
    });
    expect((await unit.run(repos => repos.transactions.findProcessedRefund(bet.transactionId)))?.id).toBe('refund');
    expect(await unit.run(repos => repos.transactions.findProcessedRefund('another-bet'))).toBeNull();
    const before = await wagerState(app);
    await expect(unit.run(async repos => {
      const tx = refund(wallet.id, 'duplicate'), reference = (await repos.transactions.findById(bet.transactionId))!;
      tx.markProcessed(reference, betTime); // Intentionally bypass the local availability check: PostgreSQL must still protect.
      await repos.transactions.insert(tx);
    })).rejects.toHaveProperty('constraint', 'wager_successful_reversal_unique');
    expect(await wagerState(app)).toEqual(before); await assertReconciled(app);
  });
}, 20000);

test.each(['PENDING_REFERENCE', 'REJECTED'] as const)('REFUND %s requires immutable historical response and protects downgrade', async status => {
  await withRefundDatabase(async ({ unit, app, orm }) => {
    const wallet = await creator(unit).execute(fundedInput), before = await wagerState(app);
    await expect(unit.run(async repos => {
      const tx = refund(wallet.id);
      if (status === 'PENDING_REFERENCE') tx.markPendingReference(); else tx.reject(FailureCode.DuplicateReversal);
      await repos.transactions.insert(tx);
    })).rejects.toHaveProperty('code', '23514');
    expect(await wagerState(app)).toEqual(before);
    await unit.run(async repos => {
      const tx = refund(wallet.id);
      if (status === 'PENDING_REFERENCE') {
        tx.markPendingReference(); await repos.transactions.insert(tx);
        await repos.wagerResults.insertPendingReceipt({ transactionId: tx.id, status: WagerTransactionStatus.PendingReference, balance: wallet.balance }, 1);
      } else {
        tx.reject(FailureCode.DuplicateReversal); await repos.transactions.insert(tx);
        await repos.wagerResults.insert({ transactionId: tx.id, status: WagerTransactionStatus.Rejected,
          failureCode: FailureCode.DuplicateReversal, balance: wallet.balance }, 1);
      }
    });
    const captured = await wagerState(app);
    await expect(orm.migrator.down({ to: 'Migration20261023000006' })).rejects.toHaveProperty('code', '55000');
    expect(await wagerState(app)).toEqual(captured); await assertReconciled(app);
  });
}, 20000);
