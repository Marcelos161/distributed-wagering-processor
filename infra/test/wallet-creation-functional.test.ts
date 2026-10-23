import { expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { CreateWallet, type CreateWalletInput } from '../../src/application/wallet/create-wallet.js';
import { WalletAlreadyExistsError } from '../../src/application/errors/wallet-already-exists-error.js';
import { createApplication } from '../../src/create-application.js';
import { withMessagingDatabase } from './messaging-support.js';
import { creator, expectCounts, fundedInput, openingTime } from './wallet-creation-support.js';

test('CreateWallet zero persists only the wallet and returns an immutable plain response', async () => {
  await withMessagingDatabase(async ({ unit, app }) => {
    const response = await creator(unit).execute({ ...fundedInput, initialBalance: { amount: '0.00', currency: 'BRL' } });
    expect(response).toEqual({ id: 'case-1', playerId: 'player', balance: { amount: '0.00', currency: 'BRL' }, version: 1 });
    expect(Object.getPrototypeOf(response)).toBe(Object.prototype);
    expect(Object.isFrozen(response)).toBe(true);
    expect(Object.isFrozen(response.balance)).toBe(true);
    await expectCounts(app, '1', '0', '0', '0');
    expect((await app`SELECT balance::text, version::text FROM wallets`)[0]).toEqual({ balance: '0.00', version: '1' });
  });
}, 20_000);

test('CreateWallet positive commits linked OPENING CREDIT and two pending events with exact values', async () => {
  await withMessagingDatabase(async ({ unit, app }) => {
    const response = await creator(unit).execute({ ...fundedInput, initialBalance: { amount: '000100.00', currency: 'BRL' } });
    expect(response).toEqual({ id: 'case-1', playerId: 'player', balance: fundedInput.initialBalance, version: 1 });
    await expectCounts(app, '1', '1', '1', '2');
    const [wallet] = await app`SELECT *, balance::text, version::text FROM wallets`;
    expect(wallet).toMatchObject({ id: response.id, player_id: response.playerId, currency: 'BRL', balance: '100.00', version: '1' });
    expect(wallet.created_at.toISOString()).toBe(openingTime);
    expect(wallet.updated_at.toISOString()).toBe(openingTime);
    const [tx] = await app`SELECT *, amount::text FROM wager_transactions`;
    expect(tx).toMatchObject({ id: 'case-2', wallet_id: wallet.id, player_id: wallet.player_id,
      kind: 'OPENING', status: 'PROCESSED', amount: '100.00', currency: 'BRL',
      provider_id: 'internal:wallet-opening', external_transaction_id: 'case-2', idempotency_key: 'case-2',
      round_id: 'wallet-opening', game_id: 'wallet-opening', failure_code: null,
      reference_transaction_id: null, reference_external_transaction_id: null });
    expect(tx.payload_hash).toBe('f6deebec8b4668f02abeaca73d6b65dac83b9508d286246231aea484c583b298');
    expect(tx.created_at.toISOString()).toBe(openingTime);
    expect(tx.processed_at.toISOString()).toBe(openingTime);
    const [entry] = await app`SELECT *, amount::text, wallet_version::text, balance_before::text, balance_after::text FROM wallet_ledger_entries`;
    expect(entry).toMatchObject({ id: 'case-3', wallet_id: wallet.id, transaction_id: tx.id, wallet_version: '1',
      direction: 'CREDIT', amount: '100.00', currency: 'BRL', balance_before: '0.00', balance_after: '100.00' });
    expect(entry.created_at.toISOString()).toBe(openingTime);
    const events = await app`SELECT * FROM outbox_messages ORDER BY id`;
    expect(events.map((row: { id: string }) => row.id)).toEqual(['case-4', 'case-5']);
    for (const event of events) {
      expect(event).toMatchObject({ attempts: 0, next_attempt_at: null, published_at: null });
      expect(event.payload).toMatchObject({ eventId: event.id, eventType: event.event_type, aggregateId: event.aggregate_id,
        version: 1, correlationId: wallet.id, causationId: tx.id, occurredAt: openingTime,
        data: { walletId: wallet.id, transactionId: tx.id, money: response.balance } });
      expect(event.occurred_at.toISOString()).toBe(openingTime);
    }
    expect(events[0]).toMatchObject({ event_type: 'WagerTransactionProcessed', aggregate_id: tx.id,
      payload: { data: { kind: 'OPENING', status: 'PROCESSED' } } });
    expect(events[1]).toMatchObject({ event_type: 'WalletBalanceChanged', aggregate_id: wallet.id,
      payload: { data: { direction: 'CREDIT', walletVersion: 1, balanceBefore: { amount: '0.00', currency: 'BRL' }, balanceAfter: response.balance } } });
    const insertingTransactions = await app`SELECT xmin::text AS txid FROM wallets
      UNION SELECT xmin::text FROM wager_transactions UNION SELECT xmin::text FROM wallet_ledger_entries
      UNION SELECT xmin::text FROM outbox_messages`;
    expect(insertingTransactions).toHaveLength(1); // All five INSERTs belong to the same PostgreSQL transaction.
  });
}, 20_000);

test.each(['999999999999999999.99', '0.01'])('CreateWallet preserves supported amount %s', async amount => {
  await withMessagingDatabase(async ({ unit, app }) => {
    const result = await creator(unit).execute({ ...fundedInput, initialBalance: { amount, currency: 'BRL' } });
    expect(result.balance.amount).toBe(amount);
    expect((await app`SELECT balance::text FROM wallets`)[0].balance).toBe(amount);
    expect((await app`SELECT amount::text FROM wallet_ledger_entries`)[0].amount).toBe(amount);
    await expectCounts(app, '1', '1', '1', '2');
  });
}, 20_000);

const invalidCases: readonly [string, unknown, string][] = [
  ['fractional cent', { ...fundedInput, initialBalance: { amount: '1.005', currency: 'BRL' } }, 'INVALID_AMOUNT'],
  ['numeric transport', { ...fundedInput, initialBalance: { amount: 100, currency: 'BRL' } }, 'INVALID_AMOUNT'],
  ['currency', { ...fundedInput, initialBalance: { amount: '1.00', currency: 'JPY' } }, 'UNSUPPORTED_CURRENCY'],
  ['negative', { ...fundedInput, initialBalance: { amount: '-1.00', currency: 'BRL' } }, 'INVALID_AMOUNT'],
  ['storage overflow', { ...fundedInput, initialBalance: { amount: '1000000000000000000.00', currency: 'BRL' } }, 'RangeError'],
  ['empty player', { ...fundedInput, playerId: '' }, 'TypeError'],
  ['whitespace player', { ...fundedInput, playerId: 'bad player' }, 'TypeError'],
  ['control player', { ...fundedInput, playerId: 'bad\u0000player' }, 'TypeError'],
  ['non-string player', { ...fundedInput, playerId: 42 }, 'TypeError'],
  ['missing input', null, 'TypeError'],
];
test.each(invalidCases)('CreateWallet rejects %s without partial records', async (_label, input, errorCode) => {
  await withMessagingDatabase(async ({ unit, app }) => {
    await expect(creator(unit).execute(input as CreateWalletInput)).rejects.toHaveProperty(
      errorCode.endsWith('Error') ? 'name' : 'code', errorCode);
    await expectCounts(app, '0', '0', '0', '0');
  });
}, 20_000);

test('CreateWallet separates currencies and rejects a duplicate without changing the first opening', async () => {
  await withMessagingDatabase(async ({ unit, app }) => {
    const useCase = creator(unit);
    const first = await useCase.execute(fundedInput);
    await useCase.execute({ ...fundedInput, initialBalance: { amount: '2.00', currency: 'USD' } });
    await expect(useCase.execute(fundedInput)).rejects.toBeInstanceOf(WalletAlreadyExistsError);
    expect((await app`SELECT balance::text FROM wallets WHERE id=${first.id}`)[0].balance).toBe('100.00');
    await expectCounts(app, '2', '2', '2', '4');
  });
}, 20_000);

test('Nest composes CreateWallet with restricted PostgreSQL UUIDs and system clock without exposing an endpoint', async () => {
  await withMessagingDatabase(async ({ applicationUrl, app: sql }) => {
    const previous = process.env['DATABASE_URL'];
    process.env['DATABASE_URL'] = applicationUrl;
    let nest: INestApplication | undefined;
    try {
      nest = await createApplication({ logger: false });
      await nest.listen(0, '127.0.0.1');
      const before = Date.now();
      const response = await nest.get(CreateWallet).execute(fundedInput);
      expect(response.id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      const [row] = await sql`SELECT created_at FROM wallets WHERE id=${response.id}`;
      expect(row.created_at.getTime()).toBeGreaterThanOrEqual(before);
      expect(row.created_at.getTime()).toBeLessThanOrEqual(Date.now());
      await expectCounts(sql, '1', '1', '1', '2');
      expect((await fetch(`${await nest.getUrl()}/wallets`, { method: 'POST' })).status).toBe(404);
    } finally {
      try { await nest?.close(); } finally {
        if (previous === undefined) delete process.env['DATABASE_URL']; else process.env['DATABASE_URL'] = previous;
      }
    }
  });
}, 20_000);
