import { expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmOptions } from '../../src/infrastructure/persistence/orm-options.js';
import { MikroFinancialUnitOfWork } from '../../src/infrastructure/persistence/financial/financial-unit-of-work.js';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction.js';
import { FailureCode } from '../../src/domain/wagering/failure-code.js';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../../src/domain/messaging/financial-events.js';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message.js';
import type { WagerInput } from '../../src/application/wagering/prepare-wager.js';
import { withRefundDatabase, refundInput } from './refund-support.js';
import { creator, fundedInput } from './wallet-creation-support.js';
import { processor, betInput, betTime } from './bet-processing-support.js';
import { wagerInput, wagerState } from './wager-support.js';
import { assertReconciled } from './bet-support.js';
import { insertTransaction, expectSqlState } from './financial-schema-support.js';

test.each(['25.00', '0.10'])('full REFUND of BET %s credits exactly once with ledger events and one SQL transaction', async amount => {
  await withRefundDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute(fundedInput), useCase = processor(unit), money = { amount, currency: 'BRL' };
    const bet = await useCase.execute(betInput(wallet.id, { money }));
    const input = refundInput(wallet.id, { money }), result = await useCase.execute(input);
    expect(result).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' }, idempotentReplay: false });
    expect((await app`SELECT balance::text,version::text FROM wallets`)[0]).toEqual({ balance: '100.00', version: '3' });
    expect((await app`SELECT reference_transaction_id FROM wager_transactions WHERE id=${result.transactionId}`)[0].reference_transaction_id).toBe(bet.transactionId);
    expect(await app`SELECT direction,amount::text FROM wallet_ledger_entries WHERE transaction_id=${result.transactionId}`).toEqual([{ direction: 'CREDIT', amount }]);
    const events = await app`SELECT event_type,published_at FROM outbox_messages WHERE payload->'data'->>'transactionId'=${result.transactionId} ORDER BY id`;
    expect(events.map((e: {event_type: string}) => e.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(events.every((e: {published_at: unknown}) => e.published_at === null)).toBe(true);
    const xids = await app`SELECT xmin::text FROM wallets WHERE id=${wallet.id}
      UNION SELECT xmin::text FROM wager_transactions WHERE id=${result.transactionId}
      UNION SELECT xmin::text FROM wallet_ledger_entries WHERE transaction_id=${result.transactionId}
      UNION SELECT xmin::text FROM outbox_messages WHERE payload->'data'->>'transactionId'=${result.transactionId}
      UNION SELECT xmin::text FROM wager_transaction_results WHERE transaction_id=${result.transactionId}`;
    expect(xids).toHaveLength(1);
    const before = await wagerState(app); expect(await useCase.execute(input)).toEqual({ ...result, idempotentReplay: true });
    expect(await wagerState(app)).toEqual(before); await assertReconciled(app);
  });
}, 20000);

const invalid: readonly [string, Record<string, unknown>][] = [
  ['missing reference', { referenceExternalTransactionId: undefined }], ['zero', { money: { amount: '0.00', currency: 'BRL' } }],
  ['negative', { money: { amount: '-1.00', currency: 'BRL' } }], ['cap', { money: { amount: '1000000000000000000.00', currency: 'BRL' } }],
  ['wallet', { walletId: 'absent' }], ['player', { playerId: 'other' }], ['currency', { money: { amount: '25.00', currency: 'USD' } }],
];
test.each(invalid)('REFUND admission %s fails without partial records', async (_name, patch) => {
  await withRefundDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute(fundedInput), before = await wagerState(app);
    await expect(processor(unit).execute({ ...refundInput(wallet.id), ...patch } as WagerInput)).rejects.toThrow();
    expect(await wagerState(app)).toEqual(before); await assertReconciled(app);
  });
}, 20000);

test.each(['absent', 'pending', 'rejected', 'failed', 'WIN', 'LOSS', 'REFUND', 'wallet-player', 'currency-wallet', 'round', 'provider', 'partial', 'excess'] as const)(
  'REFUND reference %s is pending or rejected without changing the wallet', async scenario => {
    await withRefundDatabase(async ({ unit, app }) => {
      const wallet = await creator(unit).execute(fundedInput), useCase = processor(unit);
      let targetWallet = wallet.id, playerId = 'player', currency = 'BRL';
      if (scenario === 'wallet-player' || scenario === 'currency-wallet') {
        playerId = scenario === 'wallet-player' ? 'other' : 'player'; currency = scenario === 'currency-wallet' ? 'USD' : 'BRL';
        targetWallet = (await creator(unit, 'other').execute({ playerId, initialBalance: { amount: '100.00', currency } })).id;
      }
      if (scenario === 'pending' || scenario === 'failed') {
        await insertTransaction(app, { id: 'reference', external: 'reference', wallet: wallet.id, player: 'player', round: 'round' });
        if (scenario === 'failed') await unit.run(async repos => {
          const tx = (await repos.transactions.findById('reference'))!; tx.fail(FailureCode.PermanentInfrastructureFailure);
          await repos.transactions.updateLifecycle(tx); await repos.wagerResults.insert({ transactionId: tx.id,
            status: WagerTransactionStatus.Failed, failureCode: FailureCode.PermanentInfrastructureFailure, balance: wallet.balance }, 1);
        });
      } else if (scenario === 'REFUND') {
        await useCase.execute(betInput(wallet.id));
        await useCase.execute(refundInput(wallet.id, { externalTransactionId: 'reference', idempotencyKey: 'reference' }));
      } else if (scenario !== 'absent') {
        const kind = scenario === 'WIN' || scenario === 'LOSS' ? scenario : 'BET';
        await useCase.execute({ ...betInput(targetWallet), kind, playerId, externalTransactionId: 'reference', idempotencyKey: 'reference',
          providerId: scenario === 'provider' ? 'other-provider' : 'provider-a', roundId: scenario === 'round' ? 'other' : 'round',
          money: { amount: kind === 'LOSS' ? '0.00' : scenario === 'rejected' ? '101.00' : '25.00', currency } });
      }
      const beforeWallet = (await app`SELECT balance::text,version::text FROM wallets WHERE id=${wallet.id}`)[0];
      const input = refundInput(wallet.id, { referenceExternalTransactionId: 'reference',
        money: { amount: scenario === 'partial' ? '10.00' : scenario === 'excess' ? '30.00' : '25.00', currency: 'BRL' } });
      const result = await useCase.execute(input), pending = ['absent', 'pending', 'provider'].includes(scenario);
      expect(result).toMatchObject({ status: pending ? 'PENDING_REFERENCE' : 'REJECTED', balance: { amount: beforeWallet.balance },
        ...(pending ? {} : { failureCode: 'INVALID_REFERENCE' }) });
      expect((await app`SELECT balance::text,version::text FROM wallets WHERE id=${wallet.id}`)[0]).toEqual(beforeWallet);
      expect(await app`SELECT id FROM wallet_ledger_entries WHERE transaction_id=${result.transactionId}`).toEqual([]);
      expect((await app`SELECT event_type FROM outbox_messages WHERE aggregate_id=${result.transactionId}`).map((r: {event_type: string}) => r.event_type))
        .toEqual([pending ? 'WagerTransactionPendingReference' : 'WagerTransactionRejected']);
      const beforeReplay = await wagerState(app);
      expect(await useCase.execute(input)).toEqual({ ...result, idempotentReplay: true });
      expect(await wagerState(app)).toEqual(beforeReplay); await assertReconciled(app);
    });
  }, 20000);

test('second REFUND identity is audited DUPLICATE_REVERSAL, while replay and payload conflicts remain distinct', async () => {
  await withRefundDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute(fundedInput), useCase = processor(unit);
    await useCase.execute(betInput(wallet.id)); const original = await useCase.execute(refundInput(wallet.id));
    const duplicateInput = refundInput(wallet.id, { externalTransactionId: 'duplicate', idempotencyKey: 'duplicate' });
    const duplicate = await useCase.execute(duplicateInput);
    expect(duplicate).toMatchObject({ status: 'REJECTED', failureCode: 'DUPLICATE_REVERSAL', balance: { amount: '100.00' }, idempotentReplay: false });
    expect(await app`SELECT id FROM wallet_ledger_entries WHERE transaction_id=${duplicate.transactionId}`).toEqual([]);
    expect((await app`SELECT event_type FROM outbox_messages WHERE aggregate_id=${duplicate.transactionId}`)[0].event_type).toBe('WagerTransactionRejected');
    await useCase.execute(betInput(wallet.id, { externalTransactionId: 'later', idempotencyKey: 'later' }));
    const before = await wagerState(app);
    expect(await useCase.execute(refundInput(wallet.id))).toEqual({ ...original, idempotentReplay: true });
    expect(await useCase.execute(duplicateInput)).toEqual({ ...duplicate, idempotentReplay: true });
    for (const patch of [{ money: { amount: '10.00', currency: 'BRL' } }, { referenceExternalTransactionId: 'different' }])
      await expect(useCase.execute({ ...refundInput(wallet.id), ...patch })).rejects.toHaveProperty('code', 'IDEMPOTENCY_CONFLICT');
    await expect(useCase.execute(refundInput(wallet.id, { idempotencyKey: 'another' }))).rejects.toHaveProperty('code', 'EXTERNAL_TRANSACTION_CONFLICT');
    expect(await wagerState(app)).toEqual(before); await assertReconciled(app);
  });
}, 20000);

test('REFUND overflow is an audited business rejection without rounding or movement', async () => {
  await withRefundDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute({ ...fundedInput, initialBalance: { amount: '999999999999999999.99', currency: 'BRL' } });
    const useCase = processor(unit); await useCase.execute(betInput(wallet.id));
    await useCase.execute(wagerInput(wallet.id, 'WIN', { externalTransactionId: 'win', idempotencyKey: 'win', money: { amount: '25.00', currency: 'BRL' } }));
    const result = await useCase.execute(refundInput(wallet.id));
    expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'DOMAIN_RULE_VIOLATION', balance: { amount: '999999999999999999.99' } });
    expect(await app`SELECT id FROM wallet_ledger_entries WHERE transaction_id=${result.transactionId}`).toEqual([]);
    expect((await app`SELECT version::text FROM wallets`)[0].version).toBe('3'); await assertReconciled(app);
  });
}, 20000);

test.each(['processed', 'pending'] as const)('REFUND %s replay survives later movements and ORM restart', async scenario => {
  await withRefundDatabase(async ({ unit, app, appOrm, applicationUrl }) => {
    const wallet = await creator(unit).execute(fundedInput), useCase = processor(unit);
    if (scenario === 'processed') await useCase.execute(betInput(wallet.id));
    const input = refundInput(wallet.id), original = await useCase.execute(input);
    await useCase.execute(betInput(wallet.id, { externalTransactionId: 'later', idempotencyKey: 'later' }));
    const before = await wagerState(app); await appOrm.close();
    const fresh = await MikroORM.init(createOrmOptions(applicationUrl));
    try { expect(await processor(new MikroFinancialUnitOfWork(fresh)).execute(input)).toEqual({ ...original, idempotentReplay: true }); }
    finally { await fresh.close(); }
    expect(await wagerState(app)).toEqual(before); await assertReconciled(app);
  });
}, 20000);

test('independent providers may reuse the same BET and REFUND external keys', async () => {
  await withRefundDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute(fundedInput), useCase = processor(unit);
    for (const providerId of ['provider-a', 'provider-b']) {
      await useCase.execute(betInput(wallet.id, { providerId }));
      expect((await useCase.execute(refundInput(wallet.id, { providerId }))).balance.amount).toBe('100.00');
    }
    expect((await app`SELECT count(*)::text n FROM wager_transactions WHERE kind='REFUND' AND status='PROCESSED'`)[0].n).toBe('2');
    await assertReconciled(app);
  });
}, 20000);

test('pending REFUND keeps original receipt when a simulated future worker commits its terminal result', async () => {
  await withRefundDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute(fundedInput), useCase = processor(unit), input = refundInput(wallet.id);
    const pending = await useCase.execute(input); const bet = await useCase.execute(betInput(wallet.id));
    expect(await useCase.execute(input)).toEqual({ ...pending, idempotentReplay: true });
    await unit.run(async repos => {
      await repos.wagerAdmission.lock(input.providerId, input.idempotencyKey, input.externalTransactionId);
      const locked = (await repos.wallets.findByIdForUpdate(wallet.id))!, tx = (await repos.transactions.findById(pending.transactionId))!;
      const reference = (await repos.transactions.findById(bet.transactionId))!;
      tx.assertRefundAvailable(reference, await repos.transactions.findProcessedRefund(reference.id));
      const movement = locked.credit({ money: tx.money, transactionId: tx.id, ledgerEntryId: 'future-entry', at: betTime });
      tx.markProcessed(reference, betTime); await repos.wallets.save(locked); await repos.transactions.updateLifecycle(tx);
      await repos.ledger.insert(movement.entry, movement.walletVersion);
      const ctx = { correlationId: tx.id, occurredAt: betTime };
      await repos.outbox.insert(OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, { ...ctx, eventId: 'future-processed' })));
      await repos.outbox.insert(OutboxMessage.enqueue(WalletBalanceChanged.from(locked, movement.entry, { ...ctx, eventId: 'future-balance' })));
      await repos.wagerResults.insert({ transactionId: tx.id, status: WagerTransactionStatus.Processed, balance: locked.balance.toJSON() }, locked.version);
    });
    const replay = await useCase.execute(input); expect(replay).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' }, idempotentReplay: true });
    expect((await unit.run(repos => repos.wagerResults.findPendingReceipt(pending.transactionId)))?.status).toBe(WagerTransactionStatus.PendingReference);
    expect((await app`SELECT wallet_version::text FROM wager_pending_receipts`)[0].wallet_version).toBe('1');
    expect((await app`SELECT wallet_version::text FROM wager_transaction_results WHERE transaction_id=${pending.transactionId}`)[0].wallet_version).toBe('3');
    await assertReconciled(app);
  });
}, 20000);

test('BET cannot be PENDING_REFERENCE under the existing domain and SQL shape', async () => {
  await withRefundDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute(fundedInput);
    await expectSqlState(() => insertTransaction(app, { wallet: wallet.id, player: 'player', status: 'PENDING_REFERENCE', externalReference: 'another' }), '23514');
    await assertReconciled(app);
  });
}, 20000);
