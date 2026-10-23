import { expect, test } from 'bun:test';
import { Money } from '../src/domain/money/money.js';
import { Wallet } from '../src/domain/wallet/wallet.js';
import { WagerTransaction, WagerTransactionKind as Kind } from '../src/domain/wagering/wager-transaction.js';
import { FailureCode } from '../src/domain/wagering/failure-code.js';
import { WagerTransactionProcessed, WagerTransactionRejected, WagerTransactionPendingReference, WalletBalanceChanged } from '../src/domain/messaging/financial-events.js';
import { immutableJson } from '../src/domain/messaging/message-values.js';

const at = new Date('2026-10-23T12:00:00.123Z');
const ctx = { eventId: 'event', correlationId: 'correlation', causationId: 'message', occurredAt: at };
function transaction(kind = Kind.Bet, reference = false): WagerTransaction {
  const props = { id: 'tx', providerId: 'provider', externalTransactionId: 'external', idempotencyKey: 'key',
    payloadHash: 'hash', walletId: 'wallet', playerId: 'player', roundId: 'round', gameId: 'game',
    money: Money.from({ amount: kind === Kind.Loss ? '0.00' : '10.00', currency: 'BRL' }), createdAt: at };
  return kind === Kind.Opening ? WagerTransaction.createOpening(props)
    : WagerTransaction.create({ ...props, kind, ...(reference ? { referenceExternalTransactionId: 'bet' } : {}) });
}
test.each([Kind.Bet, Kind.Win, Kind.Loss, Kind.Opening])('processed %s has stable v1 envelope and exact MoneyProps', kind => {
  const tx = transaction(kind); tx.markProcessed(undefined, at);
  const event = WagerTransactionProcessed.from(tx, ctx);
  expect(event.eventType).toBe('WagerTransactionProcessed'); expect(event.version).toBe(1);
  expect(event.aggregateId).toBe(tx.id); expect(event.toJSON().data.money).toEqual(tx.money.toJSON());
  expect(event.toJSON().occurredAt).toBe(at.toISOString());
  expect(JSON.parse(JSON.stringify(event)).causationId).toBe('message');
  expect(event.data.money).not.toBeInstanceOf(Money);
});
test('rejection and waiting events require matching lifecycle', () => {
  const rejected = transaction(); rejected.reject(FailureCode.InsufficientFunds);
  expect(WagerTransactionRejected.from(rejected, ctx).data.failureCode).toBe(FailureCode.InsufficientFunds);
  const waiting = transaction(Kind.Refund, true); waiting.markPendingReference();
  expect(WagerTransactionPendingReference.from(waiting, ctx).data.referenceExternalTransactionId).toBe('bet');
  expect(() => WagerTransactionProcessed.from(rejected, ctx)).toThrow();
  expect(() => WagerTransactionRejected.from(waiting, ctx)).toThrow();
  expect(() => WagerTransactionPendingReference.from(transaction(), ctx)).toThrow();
});
test('opening balance event is deeply immutable and timestamps are defensive', () => {
  const date = new Date(at);
  const { wallet, openingEntry } = Wallet.open({ id: 'wallet', playerId: 'player', initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
    at, opening: { transactionId: 'tx', ledgerEntryId: 'entry' } });
  const event = WalletBalanceChanged.from(wallet, openingEntry!, { ...ctx, occurredAt: date });
  date.setTime(0); event.occurredAt.setTime(0);
  expect(event.occurredAt).toEqual(at); expect(event.aggregateId).toBe('wallet');
  expect(() => { event.data.money.amount = '99.00'; }).toThrow();
  expect(() => { event.toJSON().data.balanceBefore.amount = '99.00'; }).toThrow();
  expect(Object.isFrozen(event)).toBe(true); expect(event.data.walletVersion).toBe(1);
  const other = Wallet.open({ id: 'other', playerId: 'other', initialBalance: Money.zero('BRL'), at }).wallet;
  expect(() => WalletBalanceChanged.from(other, openingEntry!, ctx)).toThrow();
});
test('context validation and absent causation do not manufacture IDs or time', () => {
  const tx = transaction(); tx.markProcessed(undefined, at);
  expect(() => WagerTransactionProcessed.from(tx, { ...ctx, eventId: '' })).toThrow();
  expect(() => WagerTransactionProcessed.from(tx, { ...ctx, occurredAt: new Date(NaN) })).toThrow();
  expect(WagerTransactionProcessed.from(tx, { eventId: 'id', correlationId: 'c', occurredAt: at }).toJSON()).not.toHaveProperty('causationId');
});
test('JSON copier rejects lossy objects and cycles and detaches mutable input', () => {
  const input = { nested: { value: 'original' } }; const copy = immutableJson(input); input.nested.value = 'changed';
  expect(copy.nested.value).toBe('original');
  for (const value of [new Date(), Money.zero('BRL'), undefined, NaN, 1n]) expect(() => immutableJson(value)).toThrow();
  const cyclic: { self?: unknown } = {}; cyclic.self = cyclic; expect(() => immutableJson(cyclic)).toThrow();
});
