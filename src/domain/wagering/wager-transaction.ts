import { Money } from '../money/money.js';
import { LedgerDirection } from '../wallet/wallet-ledger-entry.js';
import { FailureCode } from './failure-code.js';
import { InvalidTransactionStateError, WagerTransactionError } from './wager-transaction-error.js';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export interface CreateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
  readonly createdAt: Date;
}

export type CreateOpeningTransactionProps = Omit<CreateWagerTransactionProps, 'kind' | 'referenceExternalTransactionId'>;

export interface WagerTransactionState extends CreateWagerTransactionProps {
  readonly status: WagerTransactionStatus;
  readonly referenceTransactionId?: string | undefined;
  readonly failureCode?: FailureCode | undefined;
  readonly processedAt?: Date | undefined;
}

interface Lifecycle {
  readonly status: WagerTransactionStatus;
  readonly referenceTransactionId: string | undefined;
  readonly failureCode: FailureCode | undefined;
  readonly processedAtMilliseconds: number | undefined;
}

const constructionToken = Symbol('WagerTransaction construction');

export class WagerTransaction {
  public readonly id: string;
  public readonly providerId: string;
  public readonly externalTransactionId: string;
  public readonly idempotencyKey: string;
  public readonly payloadHash: string;
  public readonly walletId: string;
  public readonly playerId: string;
  public readonly roundId: string;
  public readonly gameId: string;
  public readonly kind: WagerTransactionKind;
  public readonly money: Money;
  public readonly referenceExternalTransactionId: string | undefined;
  readonly #createdAtMilliseconds: number;
  #lifecycle: Lifecycle;

  private constructor(state: WagerTransactionState, token: typeof constructionToken) {
    if (token !== constructionToken) throw new TypeError('Use WagerTransaction factories');
    WagerTransaction.#assertStructure(state);
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.#createdAtMilliseconds = state.createdAt.getTime();
    this.#lifecycle = Object.freeze({
      status: state.status, referenceTransactionId: state.referenceTransactionId,
      failureCode: state.failureCode, processedAtMilliseconds: state.processedAt?.getTime(),
    });
    this.#assertLifecycle();
    Object.freeze(this);
  }

  /** Admission for external operations. OPENING has an explicit internal factory. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    WagerTransaction.#assertObject(props);
    if (props.kind === WagerTransactionKind.Opening) {
      throw new WagerTransactionError('INTERNAL_ONLY_KIND', 'OPENING must use createOpening');
    }
    return new WagerTransaction({ ...props, status: WagerTransactionStatus.Pending,
      referenceTransactionId: undefined, failureCode: undefined, processedAt: undefined }, constructionToken);
  }

  static createOpening(props: CreateOpeningTransactionProps): WagerTransaction {
    WagerTransaction.#assertObject(props);
    // Fail closed if untyped external data supplies a different kind or a reference.
    if (('kind' in props && props.kind !== WagerTransactionKind.Opening)
      || ('referenceExternalTransactionId' in props && props.referenceExternalTransactionId !== undefined)) {
      throw new WagerTransactionError('INTERNAL_ONLY_KIND', 'Opening context cannot contain another kind or reference');
    }
    return new WagerTransaction({ ...props, kind: WagerTransactionKind.Opening,
      status: WagerTransactionStatus.Pending, referenceTransactionId: undefined,
      failureCode: undefined, processedAt: undefined }, constructionToken);
  }

  /** Reconstructs a coherent snapshot; does not resolve references or replay transitions. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state, constructionToken);
  }

  get status(): WagerTransactionStatus { return this.#lifecycle.status; }
  get referenceTransactionId(): string | undefined { return this.#lifecycle.referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this.#lifecycle.failureCode; }
  get createdAt(): Date { return new Date(this.#createdAtMilliseconds); }
  get processedAt(): Date | undefined {
    const value = this.#lifecycle.processedAtMilliseconds;
    return value === undefined ? undefined : new Date(value);
  }

  markProcessed(reference: WagerTransaction | undefined, at: Date): void {
    this.#assertMutable();
    WagerTransaction.#assertDate(at);
    this.#assertReference(reference);
    this.#lifecycle = Object.freeze({ status: WagerTransactionStatus.Processed,
      referenceTransactionId: reference?.id, failureCode: undefined, processedAtMilliseconds: at.getTime() });
  }

  markPendingReference(): void {
    this.#assertMutable();
    if (this.status !== WagerTransactionStatus.Pending || this.referenceExternalTransactionId === undefined) {
      throw new InvalidTransactionStateError('Only PENDING with an external reference can wait for it');
    }
    this.#lifecycle = Object.freeze({ ...this.#lifecycle, status: WagerTransactionStatus.PendingReference });
  }

  reject(code: FailureCode): void {
    this.#assertMutable();
    this.#assertRejectionCode(code);
    this.#lifecycle = Object.freeze({ ...this.#lifecycle, status: WagerTransactionStatus.Rejected, failureCode: code });
  }

  fail(code: FailureCode): void {
    this.#assertMutable();
    if (code !== FailureCode.PermanentInfrastructureFailure) {
      throw new WagerTransactionError('INVALID_FAILURE_CODE', 'FAILED requires a permanent infrastructure failure');
    }
    this.#lifecycle = Object.freeze({ ...this.#lifecycle, status: WagerTransactionStatus.Failed, failureCode: code });
  }

  isTerminal(): boolean {
    return this.status === WagerTransactionStatus.Processed || this.status === WagerTransactionStatus.Rejected
      || this.status === WagerTransactionStatus.Failed;
  }

  /** Potential/recorded effect, not authorization to apply money again. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss && this.status !== WagerTransactionStatus.Rejected
      && this.status !== WagerTransactionStatus.Failed;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean { return this.payloadHash === payloadHash; }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | null {
    if (!this.affectsBalance()) return null;
    this.#assertReference(reference);
    if (this.kind === WagerTransactionKind.Bet) return LedgerDirection.Debit;
    if (this.kind === WagerTransactionKind.Rollback) {
      // assertReference proved that the target is a processed BET, WIN or REFUND.
      return reference!.kind === WagerTransactionKind.Bet ? LedgerDirection.Credit : LedgerDirection.Debit;
    }
    return LedgerDirection.Credit;
  }

  #assertMutable(): void {
    if (this.isTerminal()) throw new InvalidTransactionStateError(`Cannot transition terminal ${this.status}`);
  }

  #assertReference(reference: WagerTransaction | undefined): void {
    if (this.referenceExternalTransactionId === undefined) {
      if (reference !== undefined) throw new WagerTransactionError('INVALID_REFERENCE', 'Unexpected reference');
      return;
    }
    if (reference === undefined) throw new WagerTransactionError('REFERENCE_REQUIRED', 'Resolve the external reference first');
    if (!(reference instanceof WagerTransaction) || reference.id === this.id
      || reference.externalTransactionId !== this.referenceExternalTransactionId
      || (this.referenceTransactionId !== undefined && reference.id !== this.referenceTransactionId)) {
      throw new WagerTransactionError('INVALID_REFERENCE', 'Reference identity does not match');
    }
    for (const field of ['providerId', 'playerId', 'walletId', 'roundId'] as const) {
      if (reference[field] !== this[field]) throw new WagerTransactionError('INVALID_REFERENCE', `Reference ${field} differs`);
    }
    if (reference.money.currency !== this.money.currency) {
      throw new WagerTransactionError('INVALID_REFERENCE', 'Reference currency differs');
    }
    const allowedKind = reference.kind === WagerTransactionKind.Bet
      || (this.kind === WagerTransactionKind.Rollback
        && (reference.kind === WagerTransactionKind.Win || reference.kind === WagerTransactionKind.Refund));
    if (!allowedKind || (this.requiresReference() && !this.money.equals(reference.money))) {
      throw new WagerTransactionError('INVALID_REFERENCE', 'Reference kind or full reversal amount differs');
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      throw new WagerTransactionError(reference.isTerminal() ? 'INVALID_REFERENCE' : 'REFERENCE_NOT_PROCESSED',
        'Reference must be PROCESSED');
    }
  }

  #assertRejectionCode(code: FailureCode): void {
    const allowed = code === FailureCode.DomainRuleViolation
      || (code === FailureCode.InsufficientFunds && this.kind === WagerTransactionKind.Bet)
      || (code === FailureCode.ReversalInsufficientFunds && this.kind === WagerTransactionKind.Rollback)
      || (code === FailureCode.DuplicateReversal && this.requiresReference())
      || ((code === FailureCode.ReferenceNotFound || code === FailureCode.InvalidReference)
        && this.referenceExternalTransactionId !== undefined);
    if (!allowed) throw new WagerTransactionError('INVALID_FAILURE_CODE', 'Failure code does not describe a rejection of this operation');
  }

  #assertLifecycle(): void {
    if (!Object.values(WagerTransactionStatus).includes(this.status)) {
      throw new WagerTransactionError('INVALID_STATE', 'Unknown transaction status');
    }
    const processed = this.status === WagerTransactionStatus.Processed;
    if (processed !== (this.processedAt !== undefined)
      || (!processed && this.referenceTransactionId !== undefined)
      || (processed && (this.referenceExternalTransactionId !== undefined) !== (this.referenceTransactionId !== undefined))
      || (this.status === WagerTransactionStatus.PendingReference && this.referenceExternalTransactionId === undefined)) {
      throw new WagerTransactionError('INVALID_STATE', 'Lifecycle dates and references disagree with status');
    }
    if (this.status === WagerTransactionStatus.Rejected) this.#assertRejectionCode(this.failureCode!);
    else if (this.status === WagerTransactionStatus.Failed) {
      if (this.failureCode !== FailureCode.PermanentInfrastructureFailure) {
        throw new WagerTransactionError('INVALID_FAILURE_CODE', 'FAILED requires a permanent infrastructure failure');
      }
    } else if (this.failureCode !== undefined) {
      throw new WagerTransactionError('INVALID_FAILURE_CODE', 'Only REJECTED and FAILED carry failure codes');
    }
  }

  static #assertStructure(state: WagerTransactionState): void {
    WagerTransaction.#assertObject(state);
    for (const field of ['id', 'providerId', 'externalTransactionId', 'idempotencyKey', 'payloadHash',
      'walletId', 'playerId', 'roundId', 'gameId'] as const) {
      WagerTransaction.#assertIdentifier(state[field]);
    }
    if (!Object.values(WagerTransactionKind).includes(state.kind)) {
      throw new WagerTransactionError('INVALID_KIND', 'Unknown transaction kind');
    }
    if (!(state.money instanceof Money)) throw new WagerTransactionError('INVALID_MONEY', 'money must be Money');
    if (state.kind === WagerTransactionKind.Loss ? !state.money.isZero() : !state.money.isPositive()) {
      throw new WagerTransactionError('INVALID_AMOUNT', 'LOSS requires zero; all other kinds require a positive amount');
    }
    WagerTransaction.#assertDate(state.createdAt);
    if (state.processedAt !== undefined) WagerTransaction.#assertDate(state.processedAt);
    const external = state.referenceExternalTransactionId;
    if (external !== undefined) {
      WagerTransaction.#assertIdentifier(external);
      if (external === state.externalTransactionId || ![WagerTransactionKind.Win, WagerTransactionKind.Refund,
        WagerTransactionKind.Rollback].includes(state.kind)) {
        throw new WagerTransactionError('INVALID_REFERENCE', 'Unexpected or self reference');
      }
    } else if (state.kind === WagerTransactionKind.Refund || state.kind === WagerTransactionKind.Rollback) {
      throw new WagerTransactionError('REFERENCE_REQUIRED', 'REFUND and ROLLBACK require an external reference');
    }
    if (state.referenceTransactionId !== undefined) {
      WagerTransaction.#assertIdentifier(state.referenceTransactionId);
      if (state.referenceTransactionId === state.id) throw new WagerTransactionError('INVALID_REFERENCE', 'Self reference');
    }
  }

  static #assertObject(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new WagerTransactionError('INVALID_STATE', 'Transaction input must be an object');
    }
  }

  static #assertIdentifier(value: unknown): void {
    if (typeof value !== 'string' || value.length === 0 || /[\s\u0000-\u001f\u007f]/u.test(value)) {
      throw new WagerTransactionError('INVALID_IDENTIFIER', 'Identifiers and hashes must be non-empty tokens without whitespace or control characters');
    }
  }

  static #assertDate(value: unknown): void {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new WagerTransactionError('INVALID_DATE', 'Timestamp must be a valid Date');
    }
  }
}
