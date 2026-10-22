import { Money } from '../money/money.js';
import { WalletError } from './wallet-error.js';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry.js';

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OpenWalletProps {
  readonly id: string;
  readonly playerId: string;
  readonly initialBalance: Money;
  readonly at: Date;
  readonly opening?: {
    readonly ledgerEntryId: string;
    readonly transactionId: string;
  };
}

export interface WalletOpeningResult {
  readonly wallet: Wallet;
  readonly openingEntry: WalletLedgerEntry | null;
}

export interface WalletMovementProps {
  readonly ledgerEntryId: string;
  readonly transactionId: string;
  readonly money: Money;
  readonly at: Date;
}

export interface WalletMovementResult {
  readonly entry: WalletLedgerEntry;
  readonly walletVersion: number;
}

type MutableState = Readonly<{
  balance: Money;
  version: number;
  updatedAtMilliseconds: number;
}>;

const constructionToken = Symbol('Wallet construction');

export class Wallet {
  public readonly id: string;
  public readonly playerId: string;
  public readonly currency: string;
  readonly #createdAtMilliseconds: number;
  #state: MutableState;

  private constructor(state: WalletState, token: typeof constructionToken) {
    if (token !== constructionToken) throw new TypeError('Use Wallet.open or Wallet.rehydrate');
    Wallet.#assertObject(state);
    Wallet.#assertIdentifier(state.id, 'id');
    Wallet.#assertIdentifier(state.playerId, 'playerId');
    Wallet.#assertBalance(state.balance);
    if (state.currency !== state.balance.currency) {
      throw new WalletError('CURRENCY_MISMATCH', 'Wallet currency must match its balance');
    }
    if (!Number.isSafeInteger(state.version) || state.version < 1) {
      throw new WalletError('INVALID_VERSION', 'Wallet version must be a positive safe integer');
    }
    this.id = state.id;
    this.playerId = state.playerId;
    this.currency = state.currency;
    this.#createdAtMilliseconds = Wallet.#timestamp(state.createdAt);
    this.#state = Object.freeze({
      balance: state.balance,
      version: state.version,
      updatedAtMilliseconds: Wallet.#timestamp(state.updatedAt),
    });
    // Freeze the public surface; private state may change only through domain methods.
    Object.freeze(this);
  }

  static open(props: OpenWalletProps): WalletOpeningResult {
    Wallet.#assertObject(props);
    Wallet.#assertBalance(props.initialBalance);
    const wallet = new Wallet({
      id: props.id, playerId: props.playerId, currency: props.initialBalance.currency,
      balance: props.initialBalance, version: 1, createdAt: props.at, updatedAt: props.at,
    }, constructionToken);

    let openingEntry: WalletLedgerEntry | null = null;
    if (props.initialBalance.isPositive()) {
      if (!props.opening || typeof props.opening !== 'object' || Array.isArray(props.opening)) {
        throw new WalletError('INVALID_OPENING_CONTEXT', 'A positive opening balance requires transaction and ledger identifiers');
      }
      openingEntry = WalletLedgerEntry.create({
        id: props.opening.ledgerEntryId, transactionId: props.opening.transactionId,
        walletId: wallet.id, direction: LedgerDirection.Credit, money: wallet.balance,
        balanceBefore: Money.zero(wallet.currency), balanceAfter: wallet.balance,
        createdAt: wallet.createdAt,
      });
    } else if (props.opening !== undefined) {
      throw new WalletError('INVALID_OPENING_CONTEXT', 'A zero opening balance must not carry opening movement identifiers');
    }
    return Object.freeze({ wallet, openingEntry });
  }

  /** Trusted persistence boundary: restores state without opening or replaying movements. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state, constructionToken);
  }

  get balance(): Money {
    return this.#state.balance;
  }

  get version(): number {
    return this.#state.version;
  }

  get createdAt(): Date {
    return new Date(this.#createdAtMilliseconds);
  }

  get updatedAt(): Date {
    return new Date(this.#state.updatedAtMilliseconds);
  }

  debit(props: WalletMovementProps): WalletMovementResult {
    return this.#applyMovement(props, LedgerDirection.Debit);
  }

  credit(props: WalletMovementProps): WalletMovementResult {
    return this.#applyMovement(props, LedgerDirection.Credit);
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new WalletError('CURRENCY_MISMATCH', 'Movement currency must match the wallet');
    }
  }

  #applyMovement(props: WalletMovementProps, direction: LedgerDirection): WalletMovementResult {
    Wallet.#assertObject(props);
    const { money, at, ledgerEntryId, transactionId } = props;
    if (!(money instanceof Money)) throw new WalletError('INVALID_MONEY', 'Movement must be a Money instance');
    this.assertSameCurrency(money);
    if (!money.isPositive()) throw new WalletError('NON_POSITIVE_MOVEMENT', 'Movement must be positive');
    const updatedAtMilliseconds = Wallet.#timestamp(at);
    if (this.#state.version === Number.MAX_SAFE_INTEGER) {
      throw new WalletError('VERSION_EXHAUSTED', 'Wallet version cannot be incremented safely');
    }
    if (direction === LedgerDirection.Debit && this.balance.isLessThan(money)) {
      throw new WalletError('INSUFFICIENT_FUNDS', 'Wallet has insufficient funds');
    }
    const balance = direction === LedgerDirection.Debit
      ? this.balance.subtract(money) : this.balance.add(money);
    const entry = WalletLedgerEntry.create({
      id: ledgerEntryId, transactionId, walletId: this.id, direction, money,
      balanceBefore: this.balance, balanceAfter: balance, createdAt: new Date(updatedAtMilliseconds),
    });
    const nextState: MutableState = Object.freeze({
      balance, version: this.#state.version + 1, updatedAtMilliseconds,
    });
    const result = Object.freeze({ entry, walletVersion: nextState.version });
    // No fallible validation, allocation, callback or I/O after this single state replacement.
    this.#state = nextState;
    return result;
  }

  static #assertObject(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new WalletError('INVALID_STATE', 'Wallet input must be an object');
    }
  }

  static #assertIdentifier(value: string, field: string): void {
    if (typeof value !== 'string' || value.length === 0 || /[\s\u0000-\u001f\u007f]/u.test(value)) {
      throw new WalletError('INVALID_IDENTIFIER', `${field} must be a non-empty identifier without whitespace or control characters`);
    }
  }

  static #assertBalance(value: Money): void {
    if (!(value instanceof Money)) throw new WalletError('INVALID_MONEY', 'Balance must be a Money instance');
    if (value.isNegative()) throw new WalletError('NEGATIVE_BALANCE', 'Wallet balance must be non-negative');
  }

  static #timestamp(value: Date): number {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new WalletError('INVALID_DATE', 'Wallet timestamps must be valid Date instances');
    }
    return value.getTime();
  }
}
