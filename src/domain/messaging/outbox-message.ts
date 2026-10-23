import type { IntegrationEvent, IntegrationEventJSON } from './integration-event.js';
import { immutableJson, timestamp } from './message-values.js';
import { validateEnvelope } from './event-envelope.js';
export interface OutboxMessageState {
  id: string; aggregateId: string; eventType: string; payload: IntegrationEventJSON<unknown>;
  occurredAt: Date; attempts: number; nextAttemptAt?: Date | undefined; publishedAt?: Date | undefined;
}
const token = Symbol('OutboxMessage');
export class OutboxMessage {
  readonly id: string; readonly aggregateId: string; readonly eventType: string;
  readonly payload: IntegrationEventJSON<unknown>; readonly #occurredAt: number;
  #attempts: number; #nextAttemptAt: number | undefined; #publishedAt: number | undefined;
  private constructor(state: OutboxMessageState, key: symbol) {
    if (key !== token) throw new TypeError('Use OutboxMessage factories');
    validateEnvelope(state.payload);
    this.#occurredAt = timestamp(state.occurredAt);
    if (state.id !== state.payload.eventId || state.aggregateId !== state.payload.aggregateId
      || state.eventType !== state.payload.eventType || state.occurredAt.toISOString() !== state.payload.occurredAt) throw new TypeError('Outbox envelope mismatch');
    if (!Number.isInteger(state.attempts) || state.attempts < 0 || state.attempts > 2147483647) throw new RangeError('Invalid attempt counter');
    this.id = state.id; this.aggregateId = state.aggregateId; this.eventType = state.eventType;
    this.payload = immutableJson(state.payload); this.#attempts = state.attempts;
    this.#nextAttemptAt = state.nextAttemptAt === undefined ? undefined : timestamp(state.nextAttemptAt);
    this.#publishedAt = state.publishedAt === undefined ? undefined : timestamp(state.publishedAt);
    if ((this.#publishedAt !== undefined && (this.#nextAttemptAt !== undefined || this.#publishedAt < this.#occurredAt))
      || (this.#publishedAt === undefined && (this.#attempts > 0) !== (this.#nextAttemptAt !== undefined))
      || (this.#nextAttemptAt !== undefined && this.#nextAttemptAt < this.#occurredAt)) throw new TypeError('Inconsistent outbox lifecycle');
    Object.freeze(this);
  }
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage({ id: event.eventId, aggregateId: event.aggregateId, eventType: event.eventType,
      payload: event.toJSON(), occurredAt: event.occurredAt, attempts: 0 }, token);
  }
  static rehydrate(state: OutboxMessageState): OutboxMessage { return new OutboxMessage(state, token); }
  get occurredAt(): Date { return new Date(this.#occurredAt); }
  get attempts(): number { return this.#attempts; }
  get nextAttemptAt(): Date | undefined { return this.#nextAttemptAt === undefined ? undefined : new Date(this.#nextAttemptAt); }
  get publishedAt(): Date | undefined { return this.#publishedAt === undefined ? undefined : new Date(this.#publishedAt); }
  isPending(): boolean { return this.#publishedAt === undefined; }
  isDue(now: Date): boolean { return this.isPending() && timestamp(now) >= (this.#nextAttemptAt ?? this.#occurredAt); }
  markPublished(at: Date): void {
    if (!this.isDue(at)) throw new Error('Outbox is not due or already published');
    this.#publishedAt = timestamp(at); this.#nextAttemptAt = undefined;
  }
  scheduleRetry(now: Date): void {
    if (!this.isDue(now) || this.#attempts === 2147483647) throw new Error('Outbox cannot retry in this state');
    const delay = Math.min(1000 * 2 ** Math.min(this.#attempts, 9), 300000);
    const next = timestamp(now) + delay;
    timestamp(new Date(next)); // Validate before mutating: overflowing dates must leave state unchanged.
    this.#attempts++; this.#nextAttemptAt = next;
  }
}
