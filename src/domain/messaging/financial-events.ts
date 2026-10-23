import type { MoneyProps } from '../money/money.js';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../wagering/wager-transaction.js';
import type { FailureCode } from '../wagering/failure-code.js';
import { Wallet } from '../wallet/wallet.js';
import { WalletLedgerEntry, LedgerDirection } from '../wallet/wallet-ledger-entry.js';
import { IntegrationEvent, type EventContext, type IntegrationEventProps } from './integration-event.js';

export interface TransactionEventData {
  readonly transactionId: string; readonly providerId: string; readonly externalTransactionId: string;
  readonly walletId: string; readonly playerId: string; readonly roundId: string; readonly gameId: string;
  readonly kind: WagerTransactionKind; readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string; readonly referenceTransactionId?: string;
}
export interface ProcessedData extends TransactionEventData { readonly status: WagerTransactionStatus.Processed; }
export interface RejectedData extends TransactionEventData { readonly status: WagerTransactionStatus.Rejected; readonly failureCode: FailureCode; }
export interface PendingReferenceData extends TransactionEventData {
  readonly status: WagerTransactionStatus.PendingReference; readonly referenceExternalTransactionId: string;
}
export interface WalletBalanceChangedData {
  readonly walletId: string; readonly transactionId: string; readonly direction: LedgerDirection;
  readonly money: MoneyProps; readonly balanceBefore: MoneyProps; readonly balanceAfter: MoneyProps;
  readonly walletVersion: number;
}

function transactionData(tx: WagerTransaction, status: WagerTransactionStatus): TransactionEventData {
  if (!(tx instanceof WagerTransaction) || tx.status !== status) throw new Error(`Event requires ${status} transaction`);
  return { transactionId: tx.id, providerId: tx.providerId, externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId, playerId: tx.playerId, roundId: tx.roundId, gameId: tx.gameId, kind: tx.kind,
    money: tx.money.toJSON(),
    ...(tx.referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId: tx.referenceExternalTransactionId }),
    ...(tx.referenceTransactionId === undefined ? {} : { referenceTransactionId: tx.referenceTransactionId }) };
}

export class WagerTransactionProcessed extends IntegrationEvent<ProcessedData> {
  readonly eventType = 'WagerTransactionProcessed'; readonly version = 1;
  private constructor(props: IntegrationEventProps<ProcessedData>) { super(props); Object.freeze(this); }
  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({ ...ctx, aggregateId: tx.id,
      data: { ...transactionData(tx, WagerTransactionStatus.Processed), status: WagerTransactionStatus.Processed } });
  }
}
export class WagerTransactionRejected extends IntegrationEvent<RejectedData> {
  readonly eventType = 'WagerTransactionRejected'; readonly version = 1;
  private constructor(props: IntegrationEventProps<RejectedData>) { super(props); Object.freeze(this); }
  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({ ...ctx, aggregateId: tx.id,
      data: { ...transactionData(tx, WagerTransactionStatus.Rejected), status: WagerTransactionStatus.Rejected, failureCode: tx.failureCode! } });
  }
}
export class WagerTransactionPendingReference extends IntegrationEvent<PendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference'; readonly version = 1;
  private constructor(props: IntegrationEventProps<PendingReferenceData>) { super(props); Object.freeze(this); }
  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({ ...ctx, aggregateId: tx.id,
      data: { ...transactionData(tx, WagerTransactionStatus.PendingReference), status: WagerTransactionStatus.PendingReference,
        referenceExternalTransactionId: tx.referenceExternalTransactionId! } });
  }
}
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged'; readonly version = 1;
  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) { super(props); Object.freeze(this); }
  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    if (!(wallet instanceof Wallet) || !(entry instanceof WalletLedgerEntry) || wallet.id !== entry.walletId
      || !wallet.balance.equals(entry.balanceAfter) || !entry.isBalanced()) throw new Error('Event requires matching wallet and ledger');
    return new WalletBalanceChanged({ ...ctx, aggregateId: wallet.id, data: { walletId: wallet.id,
      transactionId: entry.transactionId, direction: entry.direction, money: entry.money.toJSON(),
      balanceBefore: entry.balanceBefore.toJSON(), balanceAfter: entry.balanceAfter.toJSON(), walletVersion: wallet.version } });
  }
}
