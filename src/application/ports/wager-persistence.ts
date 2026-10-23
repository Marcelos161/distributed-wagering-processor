import type { WagerResultSnapshot } from '../wagering/wager-result.js';

export interface WagerAdmissionRepository {
  /** Once per transaction, before financial wallet locks or writes. */
  lock(providerId: string, idempotencyKey: string, externalTransactionId: string): Promise<void>;
}
export interface WagerResultRepository {
  findByTransactionId(id: string): Promise<WagerResultSnapshot | null>;
  insert(result: WagerResultSnapshot, walletVersion: number): Promise<void>;
}
