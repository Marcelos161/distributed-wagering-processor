import { InboxMessage } from '../../../domain/messaging/inbox-message.js';
import { OutboxMessage } from '../../../domain/messaging/outbox-message.js';
import type { IntegrationEventJSON } from '../../../domain/messaging/integration-event.js';
import { readTimestamp } from './timestamp-mapper.js';
export interface InboxRecord {
  message_id: string; consumer_name: string; payload_hash: string;
  received_at: Date | string; processed_at: Date | string | null;
}
export interface OutboxRecord {
  id: string; aggregate_id: string; event_type: string; payload: IntegrationEventJSON<unknown>;
  occurred_at: Date | string; attempts: number; next_attempt_at: Date | string | null; published_at: Date | string | null;
}
export class InboxMapper {
  static toDomain(row: InboxRecord): InboxMessage {
    return InboxMessage.rehydrate({ messageId: row.message_id, consumerName: row.consumer_name, payloadHash: row.payload_hash,
      receivedAt: readTimestamp(row.received_at), processedAt: row.processed_at === null ? undefined : readTimestamp(row.processed_at) });
  }
  static toRecord(message: InboxMessage): InboxRecord {
    return { message_id: message.messageId, consumer_name: message.consumerName, payload_hash: message.payloadHash,
      received_at: message.receivedAt, processed_at: message.processedAt ?? null };
  }
}
export class OutboxMapper {
  static toDomain(row: OutboxRecord): OutboxMessage {
    return OutboxMessage.rehydrate({ id: row.id, aggregateId: row.aggregate_id, eventType: row.event_type, payload: row.payload,
      occurredAt: readTimestamp(row.occurred_at), attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at === null ? undefined : readTimestamp(row.next_attempt_at),
      publishedAt: row.published_at === null ? undefined : readTimestamp(row.published_at) });
  }
  static toRecord(message: OutboxMessage): OutboxRecord {
    return { id: message.id, aggregate_id: message.aggregateId, event_type: message.eventType, payload: message.payload,
      occurred_at: message.occurredAt, attempts: message.attempts, next_attempt_at: message.nextAttemptAt ?? null, published_at: message.publishedAt ?? null };
  }
}
