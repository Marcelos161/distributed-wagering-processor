import { Money } from '../money/money.js';
import { LedgerEntryError } from './ledger-entry-error.js';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

const constructionToken = Symbol('WalletLedgerEntry construction');

export class WalletLedgerEntry {
  public readonly id: string;
  public readonly walletId: string;
  public readonly transactionId: string;
  public readonly direction: LedgerDirection;
  public readonly money: Money;
  public readonly balanceBefore: Money;
  public readonly balanceAfter: Money;
  readonly #createdAtMilliseconds: number;

  private constructor(state: LedgerEntryState, token: typeof constructionToken) {
    if (token !== constructionToken) {
      throw new TypeError('Use WalletLedgerEntry.create or WalletLedgerEntry.rehydrate');
    }
    WalletLedgerEntry.#assertState(state);
    this.id = state.id;
    this.walletId = state.walletId;
    this.transactionId = state.transactionId;
    this.direction = state.direction;
    this.money = state.money;
    this.balanceBefore = state.balanceBefore;
    this.balanceAfter = state.balanceAfter;
    this.#createdAtMilliseconds = state.createdAt.getTime();
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(props, constructionToken);
    if (!entry.isBalanced()) {
      throw new LedgerEntryError('UNBALANCED_ENTRY', 'Ledger balances must match the movement and direction');
    }
    return entry;
  }

  /** Persistence boundary only: reconstructs state without replaying the movement. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(state, constructionToken);
  }

  get createdAt(): Date {
    return new Date(this.#createdAtMilliseconds);
  }

  isBalanced(): boolean {
    const expected = this.direction === LedgerDirection.Debit
      ? this.balanceBefore.subtract(this.money)
      : this.balanceBefore.add(this.money);
    return expected.equals(this.balanceAfter);
  }

  static #assertState(state: LedgerEntryState): void {
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw new LedgerEntryError('INVALID_STATE', 'Ledger state must be an object');
    }
    for (const field of ['id', 'walletId', 'transactionId'] as const) {
      const value = state[field];
      if (typeof value !== 'string' || value.length === 0 || /[\s\u0000-\u001f\u007f]/u.test(value)) {
        throw new LedgerEntryError('INVALID_IDENTIFIER', `${field} must be a non-empty identifier without whitespace or control characters`);
      }
    }
    if (state.direction !== LedgerDirection.Debit && state.direction !== LedgerDirection.Credit) {
      throw new LedgerEntryError('INVALID_DIRECTION', 'Ledger direction must be DEBIT or CREDIT');
    }
    if (!(state.createdAt instanceof Date) || !Number.isFinite(state.createdAt.getTime())) {
      throw new LedgerEntryError('INVALID_CREATED_AT', 'createdAt must be a valid Date');
    }
    for (const field of ['money', 'balanceBefore', 'balanceAfter'] as const) {
      if (!(state[field] instanceof Money)) {
        throw new LedgerEntryError('INVALID_MONEY', `${field} must be a Money instance`);
      }
    }
    if (state.money.currency !== state.balanceBefore.currency || state.money.currency !== state.balanceAfter.currency) {
      throw new LedgerEntryError('CURRENCY_MISMATCH', 'Ledger amounts must have the same currency');
    }
    if (!state.money.isPositive()) {
      throw new LedgerEntryError('NON_POSITIVE_MOVEMENT', 'Ledger movement must be positive');
    }
    if (state.balanceBefore.isNegative() || state.balanceAfter.isNegative()) {
      throw new LedgerEntryError('NEGATIVE_BALANCE', 'Ledger balances must be non-negative');
    }
  }
}
