import { expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { createApplication } from '../../src/create-application.js';
import { ProcessWagerTransaction } from '../../src/application/wagering/process-wager-transaction.js';
import { createOrmOptions } from '../../src/infrastructure/persistence/orm-options.js';
import { MikroFinancialUnitOfWork } from '../../src/infrastructure/persistence/financial/financial-unit-of-work.js';
import { creator, fundedInput } from './wallet-creation-support.js';
import { withBetDatabase, assertReconciled } from './bet-support.js';
import { betInput, processor, databaseState, betTime } from './bet-processing-support.js';
import type { BetInput } from '../../src/application/wagering/prepare-bet.js';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction.js';
import { FailureCode } from '../../src/domain/wagering/failure-code.js';
import { prepareBet } from '../../src/application/wagering/prepare-bet.js';
import { withFinancialDatabase, insertWallet, insertTransaction } from './financial-schema-support.js';

test.each(['25.00', '100.00', '100.01'])('BET %s processes or rejects with exact financial effects and events', async amount => {
  await withBetDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute(fundedInput);
    const result = await processor(unit).execute(betInput(wallet.id, { money: { amount, currency: 'BRL' } }));
    const rejected = amount === '100.01';
    const expectedBalance = rejected ? '100.00' : amount === '100.00' ? '0.00' : '75.00';
    expect(result).toEqual({ transactionId: 'bet-1', status: rejected ? WagerTransactionStatus.Rejected : WagerTransactionStatus.Processed,
      balance: { amount: expectedBalance, currency: 'BRL' }, idempotentReplay: false,
      ...(rejected ? { failureCode: FailureCode.InsufficientFunds } : {}) });
    expect(Object.isFrozen(result.balance)).toBe(true); expect(Object.isFrozen(result)).toBe(true);
    const [tx] = await app`SELECT status,failure_code,amount::text,processed_at FROM wager_transactions WHERE id=${result.transactionId}`;
    expect(tx).toMatchObject({ status: result.status, failure_code: rejected ? 'INSUFFICIENT_FUNDS' : null, amount });
    expect(tx.processed_at?.toISOString() ?? null).toBe(rejected ? null : betTime.toISOString());
    expect((await app`SELECT balance::text,version::text FROM wallets`)[0])
      .toEqual({ balance: expectedBalance, version: rejected ? '1' : '2' });
    const entries = await app`SELECT direction,amount::text,balance_before::text,balance_after::text FROM wallet_ledger_entries WHERE transaction_id=${result.transactionId}`;
    expect(entries).toEqual(rejected ? [] : [{ direction: 'DEBIT', amount, balance_before: '100.00', balance_after: expectedBalance }]);
    const events = await app`SELECT * FROM outbox_messages WHERE payload->'data'->>'transactionId'=${result.transactionId} ORDER BY id`;
    expect(events.map((e: {event_type: string}) => e.event_type)).toEqual(rejected ? ['WagerTransactionRejected'] : ['WagerTransactionProcessed', 'WalletBalanceChanged']);
    for (const event of events) {
      expect(event).toMatchObject({ attempts: 0, published_at: null, payload: {
        correlationId: result.transactionId, causationId: result.transactionId, occurredAt: betTime.toISOString(),
        data: { walletId: wallet.id, transactionId: result.transactionId, money: { amount, currency: 'BRL' } } } });
    }
    const [stored] = await app`SELECT response, schema_version, wallet_version::text FROM wager_transaction_results`;
    const { idempotentReplay: _, ...snapshot } = result;
    expect(stored).toEqual({ response: snapshot, schema_version: 1, wallet_version: rejected ? '1' : '2' });
    expect((await app`SELECT count(*)::text AS n FROM inbox_messages`)[0].n).toBe('0');
    const xids = await app`SELECT xmin::text FROM wager_transactions WHERE id=${result.transactionId}
      UNION SELECT xmin::text FROM wallet_ledger_entries WHERE transaction_id=${result.transactionId}
      UNION SELECT xmin::text FROM outbox_messages WHERE payload->'data'->>'transactionId'=${result.transactionId}
      UNION SELECT xmin::text FROM wager_transaction_results WHERE transaction_id=${result.transactionId}`;
    expect(xids).toHaveLength(1);
    await assertReconciled(app);
  });
}, 20_000);

const invalidCases: readonly [string, Record<string, unknown>, string][] = [
  ['zero', { money: { amount: '0.00', currency: 'BRL' } }, 'INVALID_WAGER_INPUT'],
  ['currency mismatch', { money: { amount: '1.00', currency: 'USD' } }, 'WALLET_CURRENCY_MISMATCH'],
  ['missing wallet', { walletId: 'missing' }, 'WALLET_NOT_FOUND'],
  ['wrong player', { playerId: 'other' }, 'WALLET_PLAYER_MISMATCH'],
  ['malformed amount', { money: { amount: '1.001', currency: 'BRL' } }, 'INVALID_AMOUNT'],
  ['storage overflow', { money: { amount: '1000000000000000000.00', currency: 'BRL' } }, 'INVALID_WAGER_INPUT'],
  ['missing key', { idempotencyKey: undefined }, 'INVALID_WAGER_INPUT'],
];
test.each(invalidCases)('BET admission rejects %s without persistent effects', async (_name, patch, code) => {
  await withBetDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute(fundedInput);
    const before = await databaseState(app);
    await expect(processor(unit).execute({ ...betInput(wallet.id), ...patch } as BetInput)).rejects.toHaveProperty('code', code);
    expect(await databaseState(app)).toEqual(before);
    await assertReconciled(app);
  });
}, 20_000);

test('replay retains the original successful balance after another BET and ORM restart', async () => {
  await withBetDatabase(async ({ unit, app, appOrm, applicationUrl }) => {
    const wallet = await creator(unit).execute(fundedInput);
    const useCase = processor(unit);
    const original = await useCase.execute(betInput(wallet.id));
    const immediateState = await databaseState(app);
    expect(await useCase.execute(betInput(wallet.id))).toEqual({ ...original, idempotentReplay: true });
    expect(await databaseState(app)).toEqual(immediateState);
    await useCase.execute(betInput(wallet.id, { externalTransactionId: 'external-2', idempotencyKey: 'key-2', money: { amount: '10.00', currency: 'BRL' } }));
    const before = await databaseState(app);
    // Independent runtime lifecycle: close it, then start another instance and replay persisted state.
    await appOrm.close();
    const restarted = await MikroORM.init(createOrmOptions(applicationUrl));
    try {
      expect(await processor(new MikroFinancialUnitOfWork(restarted)).execute(betInput(wallet.id)))
        .toEqual({ ...original, idempotentReplay: true });
    } finally { await restarted.close(); }
    expect((await app`SELECT balance::text FROM wallets`)[0].balance).toBe('65.00');
    expect(await databaseState(app)).toEqual(before);
    await assertReconciled(app);
  });
}, 20_000);

test('rejected replay preserves rejection balance after another movement without another rejection event', async () => {
  await withBetDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute(fundedInput);
    const useCase = processor(unit);
    const input = betInput(wallet.id, { money: { amount: '101.00', currency: 'BRL' } });
    const rejected = await useCase.execute(input);
    await useCase.execute(betInput(wallet.id, { externalTransactionId: 'other', idempotencyKey: 'other' }));
    const before = await databaseState(app);
    expect(await useCase.execute(input)).toEqual({ ...rejected, idempotentReplay: true });
    expect(rejected.balance.amount).toBe('100.00');
    expect((await app`SELECT balance::text FROM wallets`)[0].balance).toBe('75.00');
    expect(await databaseState(app)).toEqual(before);
    await assertReconciled(app);
  });
}, 20_000);

test.each(['payload', 'external'] as const)('BET %s conflict preserves the original operation', async conflict => {
  await withBetDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute(fundedInput);
    const useCase = processor(unit);
    await useCase.execute(betInput(wallet.id));
    const before = await databaseState(app);
    await expect(useCase.execute(betInput(wallet.id, conflict === 'payload' ? { walletId: 'missing' } : { idempotencyKey: 'other-key' })))
      .rejects.toHaveProperty('code', conflict === 'payload' ? 'IDEMPOTENCY_CONFLICT' : 'EXTERNAL_TRANSACTION_CONFLICT');
    expect(await databaseState(app)).toEqual(before);
    await assertReconciled(app);
  });
}, 20_000);

test('same keys in distinct providers are independent financial operations', async () => {
  await withBetDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute(fundedInput);
    const useCase = processor(unit);
    await useCase.execute(betInput(wallet.id));
    const other = await useCase.execute(betInput(wallet.id, { providerId: 'provider-b' }));
    expect(other).toMatchObject({ balance: { amount: '50.00' }, idempotentReplay: false });
    await assertReconciled(app);
  });
}, 20_000);

test('Nest injects the BET use case and its public method has no financial HTTP endpoint', async () => {
  await withBetDatabase(async ({ unit, app, applicationUrl }) => {
    const wallet = await creator(unit).execute(fundedInput);
    const previous = process.env['DATABASE_URL']; process.env['DATABASE_URL'] = applicationUrl;
    let nest: INestApplication | undefined;
    try {
      nest = await createApplication({ logger: false }); await nest.listen(0, '127.0.0.1');
      const result = await nest.get(ProcessWagerTransaction).execute(betInput(wallet.id));
      expect(result.balance.amount).toBe('75.00');
      expect((await fetch(`${await nest.getUrl()}/wagering/transactions`, { method: 'POST' })).status).toBe(404);
      await assertReconciled(app);
    } finally {
      try { await nest?.close(); } finally { if (previous === undefined) delete process.env['DATABASE_URL']; else process.env['DATABASE_URL'] = previous; }
    }
  });
}, 20_000);

test.each(['PENDING', 'REJECTED'] as const)('legacy %s without original result fails closed instead of reprocessing', async status => {
  await withFinancialDatabase('Migration20261023000004', async ({ orm, app, applicationUrl }) => {
    await insertWallet(app);
    const input = betInput('wallet-1', { playerId: 'player-wallet-1', providerId: 'provider-a', roundId: 'round-1', gameId: 'game-1' });
    await insertTransaction(app, { id: 'legacy', external: input.externalTransactionId, key: input.idempotencyKey,
      hash: prepareBet(input).payloadHash, status, failure: status === 'REJECTED' ? 'INSUFFICIENT_FUNDS' : null });
    await orm.migrator.up();
    const appOrm = await MikroORM.init(createOrmOptions(applicationUrl));
    try {
      const before = await databaseState(app);
      await expect(processor(new MikroFinancialUnitOfWork(appOrm)).execute(input)).rejects.toHaveProperty('code', 'ORIGINAL_RESULT_UNAVAILABLE');
      expect(await databaseState(app)).toEqual(before);
      await assertReconciled(app);
    } finally { await appOrm.close(); }
  });
}, 20_000);
