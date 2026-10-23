import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { OutboxMapper, type OutboxRecord } from './message-mappers.js';
import type { OutboxMessage } from '../../../domain/messaging/outbox-message.js';
export interface OutboxClaim { token: string; message: OutboxMessage; }
export class OutboxDispatch {
  constructor(private readonly orm: MikroORM, private readonly leaseMs: number) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new Error('Invalid lease');
  }
  async claim(): Promise<OutboxClaim | null> {
    return this.orm.em.fork().transactional(async em => {
      const [row] = await em.execute<OutboxRecord[]>(`SELECT o.* FROM outbox_messages o LEFT JOIN outbox_claims c ON c.event_id=o.id
        WHERE o.published_at IS NULL AND COALESCE(o.next_attempt_at,o.occurred_at)<=clock_timestamp()
        AND (c.event_id IS NULL OR c.lease_until<=clock_timestamp())
        ORDER BY COALESCE(o.next_attempt_at,o.occurred_at),o.occurred_at,o.id LIMIT 1 FOR UPDATE OF o SKIP LOCKED`);
      if (!row) return null;
      const token = randomUUID();
      await em.execute(`INSERT INTO outbox_claims(event_id,token,lease_until) VALUES(?,?,clock_timestamp()+(? * interval '1 millisecond'))
        ON CONFLICT(event_id) DO UPDATE SET token=EXCLUDED.token,lease_until=EXCLUDED.lease_until`, [row.id, token, this.leaseMs]);
      return { token, message: OutboxMapper.toDomain(row) };
    });
  }
  async finish(claim: OutboxClaim, published: boolean): Promise<boolean> {
    return this.orm.em.fork().transactional(async em => {
      const [row] = await em.execute<OutboxRecord[]>(`SELECT o.* FROM outbox_messages o JOIN outbox_claims c ON c.event_id=o.id
        WHERE o.id=? AND c.token=? AND c.lease_until>clock_timestamp() AND o.published_at IS NULL FOR UPDATE OF o,c`, [claim.message.id, claim.token]);
      if (!row) return false; // Expired owner cannot overwrite a newer claim or mark its delivery.
      const message = OutboxMapper.toDomain(row), now = new Date();
      if (published) message.markPublished(now); else message.scheduleRetry(now);
      const r = OutboxMapper.toRecord(message);
      await em.execute('UPDATE outbox_messages SET attempts=?,next_attempt_at=?,published_at=? WHERE id=?', [r.attempts,r.next_attempt_at,r.published_at,r.id]);
      await em.execute('DELETE FROM outbox_claims WHERE event_id=? AND token=?', [r.id, claim.token]);
      return true;
    });
  }
}
