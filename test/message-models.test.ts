import { expect, test } from 'bun:test';
import { InboxMessage } from '../src/domain/messaging/inbox-message.js';
import { OutboxMessage } from '../src/domain/messaging/outbox-message.js';
import { WagerTransactionProcessed } from '../src/domain/messaging/financial-events.js';
import { Money } from '../src/domain/money/money.js';
import { WagerTransaction, WagerTransactionKind } from '../src/domain/wagering/wager-transaction.js';
const at = new Date('2026-10-23T12:00:00.123Z');
function event() {
  const tx = WagerTransaction.create({ id: 'tx', providerId: 'p', externalTransactionId: 'e', idempotencyKey: 'k', payloadHash: 'h',
    walletId: 'w', playerId: 'p', roundId: 'r', gameId: 'g', kind: WagerTransactionKind.Loss, money: Money.zero('BRL'), createdAt: at });
  tx.markProcessed(undefined, at);
  return WagerTransactionProcessed.from(tx, { eventId: 'event', correlationId: 'c', occurredAt: at });
}
test('inbox receive, process, rehydrate and defensive timestamps', () => {
  const props = { messageId: 'm', consumerName: 'c', payloadHash: 'h', receivedAt: new Date(at) };
  const inbox = InboxMessage.receive(props); props.receivedAt.setTime(0); inbox.receivedAt.setTime(0);
  expect(inbox.receivedAt).toEqual(at); expect(inbox.isProcessed()).toBe(false);
  expect(() => inbox.markProcessed(new Date(0))).toThrow(); inbox.markProcessed(at);
  expect(inbox.isProcessed()).toBe(true); inbox.processedAt!.setTime(0); expect(inbox.processedAt).toEqual(at);
  expect(() => inbox.markProcessed(at)).toThrow();
  expect(InboxMessage.rehydrate({ ...props, receivedAt: at, processedAt: at }).isProcessed()).toBe(true);
  expect(() => InboxMessage.receive({ ...props, messageId: '' })).toThrow();
});
test('outbox preserves event identity, is due and publishes once', () => {
  const message = OutboxMessage.enqueue(event());
  expect(message.id).toBe('event'); expect(message.payload.data).toHaveProperty('money.amount', '0.00');
  expect(message.isDue(new Date(0))).toBe(false); expect(message.isDue(at)).toBe(true);
  message.markPublished(at); expect(message.isPending()).toBe(false);
  expect(message.nextAttemptAt).toBeUndefined(); message.publishedAt!.setTime(0); expect(message.publishedAt).toEqual(at);
  expect(() => message.markPublished(at)).toThrow(); expect(() => message.scheduleRetry(at)).toThrow();
  expect(() => { (message.payload.data as { money: { amount: string } }).money.amount = '5.00'; }).toThrow();
});
test('backoff doubles and saturates at five minutes without discarding', () => {
  const message = OutboxMessage.enqueue(event()); let now = at;
  for (let index = 0; index < 15; index++) {
    message.scheduleRetry(now);
    expect(message.attempts).toBe(index + 1);
    expect(message.nextAttemptAt!.getTime() - now.getTime()).toBe(Math.min(1000 * 2 ** index, 300000));
    expect(message.isDue(now)).toBe(false); expect(() => message.scheduleRetry(now)).toThrow();
    now = message.nextAttemptAt!;
  }
  expect(message.isPending()).toBe(true); message.markPublished(now); expect(message.attempts).toBe(15);
});
test('rehydration preserves schedule without increment and rejects inconsistent envelopes', () => {
  const original = OutboxMessage.enqueue(event()); original.scheduleRetry(at);
  const state = { id: original.id, aggregateId: original.aggregateId, eventType: original.eventType, payload: original.payload,
    occurredAt: at, attempts: original.attempts, nextAttemptAt: original.nextAttemptAt };
  const copy = OutboxMessage.rehydrate(state); expect(copy.attempts).toBe(1); expect(copy.nextAttemptAt).toEqual(original.nextAttemptAt);
  expect(() => OutboxMessage.rehydrate({ ...state, attempts: -1 })).toThrow();
  expect(() => OutboxMessage.rehydrate({ ...state, id: 'different' })).toThrow();
  expect(() => OutboxMessage.rehydrate({ ...state, payload: { ...state.payload, version: 2 } })).toThrow();
  expect(() => OutboxMessage.rehydrate({ ...state, nextAttemptAt: undefined })).toThrow();
});

test('invalid lifecycle times and attempt overflow leave snapshots unchanged', () => {
  const message=OutboxMessage.enqueue(event());
  expect(() => message.markPublished(new Date(0))).toThrow();
  expect(() => message.scheduleRetry(new Date(NaN))).toThrow();
  expect(message.attempts).toBe(0); expect(message.isPending()).toBe(true);
  const maximum=OutboxMessage.rehydrate({id:message.id,aggregateId:message.aggregateId,eventType:message.eventType,
    payload:message.payload,occurredAt:at,attempts:2147483647,nextAttemptAt:at});
  expect(() => maximum.scheduleRetry(at)).toThrow();
  expect(maximum.attempts).toBe(2147483647);
  expect(() => InboxMessage.rehydrate({messageId:'m',consumerName:'c',payloadHash:'h',receivedAt:at,processedAt:new Date(0)})).toThrow();
});
