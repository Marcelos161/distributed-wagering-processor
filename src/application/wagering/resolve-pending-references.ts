import { count, record } from '../observability.js';
import type { FinancialUnitOfWork } from '../ports/financial-persistence.js';
import type { Clock } from '../ports/runtime.js';
import type { ProcessWagerTransaction } from './process-wager-transaction.js';

export interface ReferenceRetryPolicy { maxAttempts: number; ttlMs: number; initialDelayMs: number; maxDelayMs: number; }
export class ResolvePendingReferences {
  constructor(private readonly unit: FinancialUnitOfWork, private readonly process: ProcessWagerTransaction,
    private readonly clock: Clock, private readonly policy: ReferenceRetryPolicy) {
    for (const value of Object.values(policy)) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Reference retry policy requires positive integers');
    if (policy.maxDelayMs < policy.initialDelayMs || policy.maxAttempts > 1000000) throw new Error('Invalid reference retry bounds');
  }
  async runOne(): Promise<boolean> {
    const worked = await this.unit.run(async repos => {
      const now = this.clock.now(), job = await repos.pendingReferences.claimDue(now);
      if (!job) return false;
      const expire = job.attempts + 1 >= this.policy.maxAttempts || now.getTime() - job.createdAt.getTime() >= this.policy.ttlMs;
      const result = await this.process.resumeInTransaction(job.transactionId, repos, expire);
      if (result) await repos.pendingReferences.complete(job.transactionId, now);
      else {
        const delay = Math.min(this.policy.maxDelayMs, this.policy.initialDelayMs * 2 ** Math.min(job.attempts, 30));
        await repos.pendingReferences.reschedule(job.transactionId, new Date(now.getTime() + delay));
      }
      return true;
    });
    if (worked) { count('reference_checks'); record('reference_worker', { status: 'COMMITTED' }); }
    return worked;
  }
}
