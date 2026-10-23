import type { PendingReferenceJob, PendingReferenceRepository } from '../../../application/ports/pending-reference-persistence.js';
import type { FinancialSession } from './financial-session.js';

export class MikroPendingReferenceRepository implements PendingReferenceRepository {
  private claimed: string | undefined;
  constructor(private readonly session: FinancialSession) {}
  async claimDue(now: Date): Promise<PendingReferenceJob | null> {
    if (this.claimed) throw new Error('Claim one pending reference per transaction');
    const [row] = await this.session.execute<{ transaction_id: string; attempts: number; created_at: Date }[]>(`
      SELECT j.transaction_id,j.attempts,t.created_at FROM pending_reference_jobs j
      JOIN wager_transactions t ON t.id=j.transaction_id
      WHERE j.completed_at IS NULL AND j.next_attempt_at<=? AND t.status='PENDING_REFERENCE'
      ORDER BY j.next_attempt_at,j.transaction_id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`, [now]);
    if (!row) return null;
    this.claimed = row.transaction_id;
    return { transactionId: row.transaction_id, attempts: row.attempts, createdAt: new Date(row.created_at) };
  }
  async reschedule(transactionId: string, nextAttemptAt: Date): Promise<void> {
    this.assertClaim(transactionId);
    await this.session.execute('UPDATE pending_reference_jobs SET attempts=attempts+1,next_attempt_at=? WHERE transaction_id=?', [nextAttemptAt, transactionId]);
  }
  async complete(transactionId: string, now: Date): Promise<void> {
    this.assertClaim(transactionId);
    await this.session.execute('UPDATE pending_reference_jobs SET attempts=attempts+1,completed_at=? WHERE transaction_id=?', [now, transactionId]);
  }
  private assertClaim(id: string): void {
    if (this.claimed !== id) throw new Error('Claim the reference job in this transaction first');
  }
}
