import type { OutboxRepository } from '../../../application/ports/message-persistence.js';
import type { OutboxMessage } from '../../../domain/messaging/outbox-message.js';
import { timestamp } from '../../../domain/messaging/message-values.js';
import { OutboxMapper, type OutboxRecord } from './message-mappers.js';
import { FinancialSession } from './financial-session.js';
export class MikroOutboxRepository implements OutboxRepository {
  constructor(private readonly session: FinancialSession) {}
  async insert(message: OutboxMessage): Promise<void> {
    this.session.attachMessage(message);
    const r = OutboxMapper.toRecord(message);
    await this.session.execute(`INSERT INTO outbox_messages
      (id,aggregate_id,event_type,payload,occurred_at,attempts,next_attempt_at,published_at) VALUES (?,?,?,?::jsonb,?,?,?,?)`,
    [r.id,r.aggregate_id,r.event_type,JSON.stringify(r.payload),r.occurred_at,r.attempts,r.next_attempt_at,r.published_at]);
  }
  async findByIdForUpdate(id: string): Promise<OutboxMessage | null> {
    const [row] = await this.session.execute<OutboxRecord[]>('SELECT * FROM outbox_messages WHERE id=? FOR UPDATE', [id]);
    if (!row) return null;
    const message = OutboxMapper.toDomain(row); this.session.attachMessage(message); return message;
  }
  async listDue(now: Date, limit: number): Promise<readonly OutboxMessage[]> {
    timestamp(now);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('Outbox limit must be 1..1000');
    const rows = await this.session.execute<OutboxRecord[]>(`SELECT * FROM outbox_messages WHERE published_at IS NULL
      AND COALESCE(next_attempt_at,occurred_at)<=? ORDER BY COALESCE(next_attempt_at,occurred_at),occurred_at,id LIMIT ?`, [now,limit]);
    // Observation only, not a claim: publisher locking is deliberately not implemented.
    return Object.freeze(rows.map(row => OutboxMapper.toDomain(row)));
  }
  async save(message: OutboxMessage): Promise<void> {
    this.session.assertMessage(message);
    const r = OutboxMapper.toRecord(message);
    const rows = await this.session.execute<object[]>(`UPDATE outbox_messages SET attempts=?,next_attempt_at=?,published_at=?
      WHERE id=? AND published_at IS NULL RETURNING id`, [r.attempts,r.next_attempt_at,r.published_at,r.id]);
    if (rows.length !== 1) throw new Error('Outbox is already published or missing');
  }
}
