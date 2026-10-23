import { Money } from '../money/money.js';
import { WagerTransactionKind } from '../wagering/wager-transaction.js';
import { FailureCode } from '../wagering/failure-code.js';
import type { IntegrationEventJSON } from './integration-event.js';
import { assertIdentifier, immutableJson } from './message-values.js';

export function validateEnvelope(payload: IntegrationEventJSON<unknown>): void {
  immutableJson(payload);
  for (const value of [payload.eventId, payload.aggregateId, payload.correlationId]) assertIdentifier(value);
  if (payload.causationId !== undefined) assertIdentifier(payload.causationId);
  if (payload.version !== 1 || typeof payload.occurredAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(payload.occurredAt)
    || new Date(payload.occurredAt).toISOString() !== payload.occurredAt) throw new TypeError('Invalid event version or timestamp');
  const d = payload.data as Record<string, unknown>;
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new TypeError('Invalid event data');
  for (const key of ['walletId', 'transactionId']) assertIdentifier(d[key] as string);
  const money = Money.from(d['money'] as { amount: string; currency: string });
  if (payload.eventType === 'WalletBalanceChanged') {
    const before = Money.from(d['balanceBefore'] as { amount: string; currency: string });
    const after = Money.from(d['balanceAfter'] as { amount: string; currency: string });
    if (payload.aggregateId !== d['walletId'] || !money.isPositive()
      || !Number.isSafeInteger(d['walletVersion']) || (d['walletVersion'] as number) < 1
      || !['DEBIT', 'CREDIT'].includes(d['direction'] as string)
      || !(d['direction'] === 'DEBIT' ? before.subtract(money) : before.add(money)).equals(after)) throw new TypeError('Invalid balance event');
    return;
  }
  for (const key of ['providerId', 'externalTransactionId', 'playerId', 'roundId', 'gameId']) assertIdentifier(d[key] as string);
  for (const key of ['referenceExternalTransactionId', 'referenceTransactionId']) if (d[key] !== undefined) assertIdentifier(d[key] as string);
  if (payload.aggregateId !== d['transactionId'] || !Object.values(WagerTransactionKind).includes(d['kind'] as WagerTransactionKind)
    || (d['kind'] === 'LOSS' ? !money.isZero() : !money.isPositive())) throw new TypeError('Invalid transaction event');
  const statuses: Record<string, string> = { WagerTransactionProcessed: 'PROCESSED', WagerTransactionRejected: 'REJECTED', WagerTransactionPendingReference: 'PENDING_REFERENCE' };
  if (!Object.hasOwn(statuses, payload.eventType) || d['status'] !== statuses[payload.eventType]) throw new TypeError('Invalid event type or status');
  if (d['status'] === 'REJECTED' && (!Object.values(FailureCode).includes(d['failureCode'] as FailureCode)
    || [FailureCode.IdempotencyConflict, FailureCode.PermanentInfrastructureFailure].includes(d['failureCode'] as FailureCode))) throw new TypeError('Invalid rejection code');
  if (d['status'] === 'PENDING_REFERENCE') assertIdentifier(d['referenceExternalTransactionId'] as string);
}
