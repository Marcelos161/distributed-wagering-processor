import { expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmOptions } from '../../src/infrastructure/persistence/orm-options.js';
import { MikroFinancialUnitOfWork } from '../../src/infrastructure/persistence/financial/financial-unit-of-work.js';
import type { WagerInput } from '../../src/application/wagering/prepare-wager.js';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction.js';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../../src/domain/messaging/financial-events.js';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message.js';
import { withWagerDatabase, wagerInput, wagerState } from './wager-support.js';
import { creator, fundedInput } from './wallet-creation-support.js';
import { processor, betInput, betTime } from './bet-processing-support.js';
import { assertReconciled } from './bet-support.js';
import { insertTransaction } from './financial-schema-support.js';

test.each(['WIN', 'LOSS'] as const)('BET followed by %s persists exact effects events and historical version atomically', async kind => {
  await withWagerDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute(fundedInput), useCase = processor(unit);
    await useCase.execute(betInput(wallet.id));
    const result = await useCase.execute(wagerInput(wallet.id, kind, { externalTransactionId: 'result', idempotencyKey: 'result' }));
    expect(result).toMatchObject({ status: 'PROCESSED', balance: { amount: kind === 'WIN' ? '115.50' : '75.00' }, idempotentReplay: false });
    const [stored] = await app`SELECT balance::text,version::text FROM wallets`;
    expect(stored).toEqual({ balance: kind === 'WIN' ? '115.50' : '75.00', version: kind === 'WIN' ? '3' : '2' });
    const entries = await app`SELECT direction,amount::text,balance_before::text,balance_after::text FROM wallet_ledger_entries WHERE transaction_id=${result.transactionId}`;
    expect(entries).toEqual(kind === 'WIN' ? [{ direction: 'CREDIT', amount: '40.50', balance_before: '75.00', balance_after: '115.50' }] : []);
    const events = await app`SELECT event_type,published_at FROM outbox_messages WHERE payload->'data'->>'transactionId'=${result.transactionId} ORDER BY id`;
    expect(events.map((e: { event_type: string }) => e.event_type)).toEqual(kind === 'WIN' ? ['WagerTransactionProcessed', 'WalletBalanceChanged'] : ['WagerTransactionProcessed']);
    expect(events.every((e: { published_at: unknown }) => e.published_at === null)).toBe(true);
    expect((await app`SELECT wallet_version::text FROM wager_transaction_results WHERE transaction_id=${result.transactionId}`)[0].wallet_version).toBe(stored.version);
    const xids = await app`SELECT xmin::text FROM wager_transactions WHERE id=${result.transactionId}
      UNION SELECT xmin::text FROM wallet_ledger_entries WHERE transaction_id=${result.transactionId}
      UNION SELECT xmin::text FROM wager_transaction_results WHERE transaction_id=${result.transactionId}
      UNION SELECT xmin::text FROM outbox_messages WHERE payload->'data'->>'transactionId'=${result.transactionId}`;
    expect(xids).toHaveLength(1); await assertReconciled(app);
  });
}, 20000);

test('WIN decimal addition is exact and balance overflow is an audited rejection', async () => {
  await withWagerDatabase(async ({ unit, app }) => {
    const small = await creator(unit).execute({ ...fundedInput, initialBalance: { amount: '0.10', currency: 'BRL' } });
    const useCase = processor(unit);
    expect((await useCase.execute(wagerInput(small.id, 'WIN', { money: { amount: '0.20', currency: 'BRL' } }))).balance.amount).toBe('0.30');
    const large = await creator(unit, 'large').execute({ playerId: 'large', initialBalance: { amount: '999999999999999999.99', currency: 'BRL' } });
    const result = await useCase.execute(wagerInput(large.id, 'WIN', { playerId: 'large', externalTransactionId: 'overflow', idempotencyKey: 'overflow' }));
    expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'DOMAIN_RULE_VIOLATION', balance: { amount: '999999999999999999.99' } });
    expect(await app`SELECT id FROM wallet_ledger_entries WHERE transaction_id=${result.transactionId}`).toEqual([]);
    expect((await app`SELECT event_type FROM outbox_messages WHERE aggregate_id=${result.transactionId}`)[0].event_type).toBe('WagerTransactionRejected');
    await assertReconciled(app);
  });
}, 20000);

const invalid: readonly [string, 'WIN' | 'LOSS', Record<string, unknown>][] = [
  ['WIN zero', 'WIN', { money: { amount: '0.00', currency: 'BRL' } }],
  ['WIN negative', 'WIN', { money: { amount: '-1.00', currency: 'BRL' } }],
  ['WIN cap', 'WIN', { money: { amount: '1000000000000000000.00', currency: 'BRL' } }],
  ['LOSS positive', 'LOSS', { money: { amount: '1.00', currency: 'BRL' } }],
  ['LOSS reference', 'LOSS', { referenceExternalTransactionId: 'bet' }],
  ...(['WIN', 'LOSS'] as const).flatMap(kind => [
    [kind + ' missing wallet', kind, { walletId: 'absent' }],
    [kind + ' wrong player', kind, { playerId: 'other' }],
    [kind + ' wrong currency', kind, { money: { amount: kind === 'WIN' ? '1.00' : '0.00', currency: 'USD' } }],
  ] as [string, 'WIN' | 'LOSS', Record<string, unknown>][]),
];
test.each(invalid)('%s admission leaves no partial records', async (_name, kind, patch) => {
  await withWagerDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute(fundedInput), before = await wagerState(app);
    await expect(processor(unit).execute({ ...wagerInput(wallet.id, kind), ...patch } as WagerInput)).rejects.toThrow();
    expect(await wagerState(app)).toEqual(before); await assertReconciled(app);
  });
}, 20000);

test.each(['WIN', 'LOSS'] as const)('%s replay survives later movement and actual ORM restart; conflicts never write', async kind => {
  await withWagerDatabase(async ({ unit, app, appOrm, applicationUrl }) => {
    const wallet = await creator(unit).execute(fundedInput), useCase = processor(unit), input = wagerInput(wallet.id, kind);
    const original = await useCase.execute(input);
    await useCase.execute(betInput(wallet.id, { externalTransactionId: 'later', idempotencyKey: 'later' }));
    const before = await wagerState(app);
    await appOrm.close();
    const restarted = await MikroORM.init(createOrmOptions(applicationUrl));
    try {
      const fresh = processor(new MikroFinancialUnitOfWork(restarted), 'restarted');
      expect(await fresh.execute(input)).toEqual({ ...original, idempotentReplay: true });
      await expect(fresh.execute({ ...input, roundId: 'different' })).rejects.toHaveProperty('code', 'IDEMPOTENCY_CONFLICT');
      await expect(fresh.execute({ ...input, idempotencyKey: 'different' })).rejects.toHaveProperty('code', 'EXTERNAL_TRANSACTION_CONFLICT');
    } finally { await restarted.close(); }
    expect(await wagerState(app)).toEqual(before); await assertReconciled(app);
  });
}, 20000);

test.each(['WIN', 'LOSS'] as const)('%s same identities in separate providers are independent', async kind => {
  await withWagerDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute(fundedInput), useCase = processor(unit);
    const first = await useCase.execute(wagerInput(wallet.id, kind));
    const second = await useCase.execute(wagerInput(wallet.id, kind, { providerId: 'provider-b' }));
    expect(second.transactionId).not.toBe(first.transactionId);
    expect(second.balance.amount).toBe(kind === 'WIN' ? '181.00' : '100.00');
    await assertReconciled(app);
  });
}, 20000);

test('WIN resolves processed BET in provider scope and accepts a different prize and game', async () => {
  await withWagerDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute(fundedInput), useCase = processor(unit);
    const bet = await useCase.execute(betInput(wallet.id));
    const input = wagerInput(wallet.id, 'WIN', { externalTransactionId: 'win', idempotencyKey: 'win', referenceExternalTransactionId: 'external-1', gameId: 'another-game' });
    const win = await useCase.execute(input);
    expect(win.balance.amount).toBe('115.50');
    expect((await app`SELECT reference_transaction_id FROM wager_transactions WHERE id=${win.transactionId}`)[0].reference_transaction_id).toBe(bet.transactionId);
    await expect(useCase.execute({ ...input, referenceExternalTransactionId: 'different' })).rejects.toHaveProperty('code', 'IDEMPOTENCY_CONFLICT');
    await assertReconciled(app);
  });
}, 20000);

test.each(['round', 'wallet-player', 'currency', 'kind', 'rejected', 'failed', 'pending', 'absent', 'other-provider'] as const)(
  'WIN reference %s is rejected or held pending without credit', async scenario => {
    await withWagerDatabase(async ({ unit, app }) => {
      const wallet = await creator(unit).execute(fundedInput), useCase = processor(unit);
      let targetWallet = wallet.id;
      let playerId = 'player', currency = 'BRL';
      if (scenario === 'wallet-player' || scenario === 'currency') {
        playerId = scenario === 'currency' ? 'player' : 'other'; currency = scenario === 'currency' ? 'USD' : 'BRL';
        targetWallet = (await creator(unit, 'other').execute({ playerId, initialBalance: { amount: '100.00', currency } })).id;
      }
      if (scenario === 'pending' || scenario === 'failed') {
        await insertTransaction(app, { id: 'reference', wallet: wallet.id, player: 'player', external: 'reference', round: 'round' });
        if (scenario === 'failed') await unit.run(async repos => {
          const tx = (await repos.transactions.findById('reference'))!;
          tx.fail((await import('../../src/domain/wagering/failure-code.js')).FailureCode.PermanentInfrastructureFailure);
          await repos.transactions.updateLifecycle(tx);
          await repos.wagerResults.insert({ transactionId: tx.id, status: WagerTransactionStatus.Failed,
            failureCode: tx.failureCode!, balance: wallet.balance }, 1);
        });
      } else if (scenario !== 'absent') {
        await useCase.execute({ ...wagerInput(targetWallet, scenario === 'kind' ? 'LOSS' : 'WIN'),
          kind: scenario === 'kind' ? 'LOSS' : 'BET', playerId, money: { amount: scenario === 'kind' ? '0.00' : scenario === 'rejected' ? '101.00' : '25.00', currency },
          externalTransactionId: 'reference', idempotencyKey: 'reference', providerId: scenario === 'other-provider' ? 'other-provider' : 'provider-a',
          roundId: scenario === 'round' ? 'different' : 'round' });
      }
      const beforeBalance = (await app`SELECT balance::text FROM wallets WHERE id=${wallet.id}`)[0].balance;
      const input = wagerInput(wallet.id, 'WIN', { externalTransactionId: 'win', idempotencyKey: 'win', referenceExternalTransactionId: 'reference' });
      const result = await useCase.execute(input);
      const pending = ['pending', 'absent', 'other-provider'].includes(scenario);
      expect(result).toMatchObject({ status: pending ? 'PENDING_REFERENCE' : 'REJECTED', balance: { amount: beforeBalance },
        ...(pending ? {} : { failureCode: 'INVALID_REFERENCE' }) });
      expect(await app`SELECT id FROM wallet_ledger_entries WHERE transaction_id=${result.transactionId}`).toEqual([]);
      expect((await app`SELECT event_type FROM outbox_messages WHERE aggregate_id=${result.transactionId}`).map((e: {event_type: string}) => e.event_type))
        .toEqual([pending ? 'WagerTransactionPendingReference' : 'WagerTransactionRejected']);
      const before = await wagerState(app);
      expect(await useCase.execute(input)).toEqual({ ...result, idempotentReplay: true });
      expect(await wagerState(app)).toEqual(before); await assertReconciled(app);
    });
  }, 20000);

test('WIN before BET retains pending receipt; a simulated future transition adds terminal history without overwriting it', async () => {
  await withWagerDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute(fundedInput), useCase = processor(unit);
    const input = wagerInput(wallet.id, 'WIN', { externalTransactionId: 'win', idempotencyKey: 'win', referenceExternalTransactionId: 'external-1' });
    const pending = await useCase.execute(input);
    const bet = await useCase.execute(betInput(wallet.id));
    expect(await useCase.execute(input)).toEqual({ ...pending, idempotentReplay: true }); // Redelivery is not a worker.
    await unit.run(async repos => {
      await repos.wagerAdmission.lock(input.providerId, input.idempotencyKey, input.externalTransactionId);
      const locked = (await repos.wallets.findByIdForUpdate(wallet.id))!;
      const tx = (await repos.transactions.findById(pending.transactionId))!, reference = (await repos.transactions.findById(bet.transactionId))!;
      const movement = locked.credit({ money: tx.money, transactionId: tx.id, ledgerEntryId: 'future-entry', at: betTime });
      tx.markProcessed(reference, betTime); await repos.wallets.save(locked); await repos.transactions.updateLifecycle(tx);
      await repos.ledger.insert(movement.entry, movement.walletVersion);
      const ctx = { correlationId: tx.id, occurredAt: betTime };
      await repos.outbox.insert(OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, { ...ctx, eventId: 'future-processed' })));
      await repos.outbox.insert(OutboxMessage.enqueue(WalletBalanceChanged.from(locked, movement.entry, { ...ctx, eventId: 'future-balance' })));
      await repos.wagerResults.insert({ transactionId: tx.id, status: WagerTransactionStatus.Processed, balance: locked.balance.toJSON() }, locked.version);
    });
    expect(await useCase.execute(input)).toMatchObject({ status: 'PROCESSED', balance: { amount: '115.50' }, idempotentReplay: true });
    expect((await unit.run(repos => repos.wagerResults.findPendingReceipt(pending.transactionId)))?.balance.amount).toBe('100.00');
    await assertReconciled(app);
  });
}, 20000);
