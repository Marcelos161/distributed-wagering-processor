import type { InboxRepository } from '../../../application/ports/message-persistence.js';
import { InboxMessage, InboxConflictError, type ReceiveInboxProps } from '../../../domain/messaging/inbox-message.js';
import { InboxMapper, type InboxRecord } from './message-mappers.js';
import { FinancialSession } from './financial-session.js';
export class MikroInboxRepository implements InboxRepository {
  constructor(private readonly session: FinancialSession) {}
  async receive(props: ReceiveInboxProps): ReturnType<InboxRepository['receive']> {
    const r = InboxMapper.toRecord(InboxMessage.receive(props));
    const inserted = await this.session.execute<InboxRecord[]>(`INSERT INTO inbox_messages
      (consumer_name,message_id,payload_hash,received_at) VALUES (?,?,?,?)
      ON CONFLICT (consumer_name,message_id) DO NOTHING RETURNING *`, [r.consumer_name,r.message_id,r.payload_hash,r.received_at]);
    // Separate statement deliberately obtains a new READ COMMITTED snapshot after waiting on uniqueness.
    const row = inserted[0] ?? (await this.session.execute<InboxRecord[]>(
      'SELECT * FROM inbox_messages WHERE consumer_name=? AND message_id=? FOR UPDATE', [r.consumer_name,r.message_id]))[0];
    if (!row) throw new Error('Inbox record disappeared');
    if (row.payload_hash !== props.payloadHash) throw new InboxConflictError();
    const message = InboxMapper.toDomain(row); this.session.attachMessage(message);
    return { message, disposition: inserted.length ? 'new' : message.isProcessed() ? 'processed' : 'pending' };
  }
  async save(message: InboxMessage): Promise<void> {
    this.session.assertMessage(message);
    if (!message.isProcessed()) throw new Error('Inbox must be marked processed before saving');
    const rows = await this.session.execute<object[]>(`UPDATE inbox_messages SET processed_at=?
      WHERE consumer_name=? AND message_id=? AND processed_at IS NULL RETURNING message_id`,
    [message.processedAt,message.consumerName,message.messageId]);
    if (rows.length !== 1) throw new Error('Inbox has already been processed');
  }
}
