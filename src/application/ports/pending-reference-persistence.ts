export interface PendingReferenceJob {
  readonly transactionId: string;
  readonly attempts: number;
  readonly createdAt: Date;
}
export interface PendingReferenceRepository {
  claimDue(now: Date): Promise<PendingReferenceJob | null>;
  reschedule(transactionId: string, nextAttemptAt: Date): Promise<void>;
  complete(transactionId: string, now: Date): Promise<void>;
}
