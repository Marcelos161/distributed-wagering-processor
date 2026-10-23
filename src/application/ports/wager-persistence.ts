import type { WagerResultSnapshot, PendingWagerReceipt } from '../wagering/wager-result.js';

export interface WagerAdmissionRepository {
  /** Once per transaction, before financial wallet locks or writes. */
  lock(providerId: string, idempotencyKey: string, externalTransactionId: string): Promise<void>;
}
export interface WagerResultRepository {
  findByTransactionId(id: string): Promise<WagerResultSnapshot | null>;
  findPendingReceipt(id: string): Promise<PendingWagerReceipt | null>;
  insertPendingReceipt(receipt: PendingWagerReceipt, walletVersion: number): Promise<void>;
  insert(result: WagerResultSnapshot, walletVersion: number): Promise<void>;
}
