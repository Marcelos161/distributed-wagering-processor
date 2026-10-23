import { assertIdentifier, immutableJson, timestamp } from './message-values.js';

export interface EventContext {
  readonly eventId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
}
export interface IntegrationEventProps<T> extends EventContext {
  readonly aggregateId: string;
  readonly data: T;
}
export interface IntegrationEventJSON<T> {
  readonly eventId: string; readonly eventType: string; readonly version: number;
  readonly aggregateId: string; readonly correlationId: string; readonly causationId?: string;
  readonly occurredAt: string; readonly data: Readonly<T>;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly data: Readonly<T>;
  readonly #occurredAt: number;

  protected constructor(props: IntegrationEventProps<T>) {
    for (const id of [props.eventId, props.aggregateId, props.correlationId]) assertIdentifier(id);
    if (props.causationId !== undefined) assertIdentifier(props.causationId);
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.#occurredAt = timestamp(props.occurredAt);
    this.data = immutableJson(props.data);
  }
  get occurredAt(): Date { return new Date(this.#occurredAt); }
  toJSON(): IntegrationEventJSON<T> {
    return immutableJson({ eventId: this.eventId, eventType: this.eventType, version: this.version,
      aggregateId: this.aggregateId, correlationId: this.correlationId,
      ...(this.causationId === undefined ? {} : { causationId: this.causationId }),
      occurredAt: this.occurredAt.toISOString(), data: this.data });
  }
}
