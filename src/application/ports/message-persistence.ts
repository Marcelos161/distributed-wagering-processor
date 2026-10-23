import type { InboxMessage, ReceiveInboxProps } from '../../domain/messaging/inbox-message.js';
import type { OutboxMessage } from '../../domain/messaging/outbox-message.js';
export interface InboxRepository {
  receive(props: ReceiveInboxProps): Promise<{ message: InboxMessage; disposition: 'new' | 'pending' | 'processed' }>;
  save(message: InboxMessage): Promise<void>;
}
export interface OutboxRepository {
  insert(message: OutboxMessage): Promise<void>;
  findByIdForUpdate(id: string): Promise<OutboxMessage | null>;
  listDue(now: Date, limit: number): Promise<readonly OutboxMessage[]>;
  save(message: OutboxMessage): Promise<void>;
}
