import type { MoneyProps } from '../../domain/money/money.js';
import type { FailureCode } from '../../domain/wagering/failure-code.js';
import type { WagerTransactionStatus } from '../../domain/wagering/wager-transaction.js';

/** Stored once. The replay flag describes the delivery, not the original business result. */
export interface WagerResultSnapshot {
  readonly transactionId: string;
  readonly status: WagerTransactionStatus.Processed | WagerTransactionStatus.Rejected | WagerTransactionStatus.Failed;
  readonly balance: Readonly<MoneyProps>;
  readonly failureCode?: FailureCode;
}
export interface PendingWagerReceipt {
  readonly transactionId: string;
  readonly status: WagerTransactionStatus.PendingReference;
  readonly balance: Readonly<MoneyProps>;
  readonly failureCode?: never;
}
export type WagerResult = (WagerResultSnapshot | PendingWagerReceipt) & { readonly idempotentReplay: boolean };
