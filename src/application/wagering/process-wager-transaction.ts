import { count, record } from '../observability.js';
import type { FinancialRepositories, FinancialUnitOfWork } from '../ports/financial-persistence.js';
import type { Clock, IdGenerator } from '../ports/runtime.js';
import { RetryableFinancialTransactionError } from '../errors/retryable-financial-transaction-error.js';
import { prepareWager, type WagerInput, type PreparedWager } from './prepare-wager.js';
import { WagerProcessingError } from './wager-processing-error.js';
import type { WagerResult, WagerResultSnapshot, PendingWagerReceipt } from './wager-result.js';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../domain/wagering/wager-transaction.js';
import { FailureCode } from '../../domain/wagering/failure-code.js';
import { WalletError } from '../../domain/wallet/wallet-error.js';
import type { Wallet, WalletMovementResult } from '../../domain/wallet/wallet.js';
import { WagerTransactionProcessed, WagerTransactionRejected, WagerTransactionPendingReference, WalletBalanceChanged } from '../../domain/messaging/financial-events.js';
import { LedgerDirection } from '../../domain/wallet/wallet-ledger-entry.js';
import { Money } from '../../domain/money/money.js';
import { WagerTransactionError } from '../../domain/wagering/wager-transaction-error.js';
import { OutboxMessage } from '../../domain/messaging/outbox-message.js';

export class ProcessWagerTransaction {
  constructor(private readonly unit: FinancialUnitOfWork, private readonly ids: IdGenerator, private readonly clock: Clock) {}

  async execute(input: WagerInput): Promise<WagerResult> {
    const prepared = prepareWager(input), started = performance.now();
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await this.unit.run(repos => this.process(prepared, repos));
        count('transactions_' + result.status); if (result.idempotentReplay) count('duplicates');
        count('processing_duration_ms_sum', performance.now()-started); count('processing_count');
        record('wager', { transactionId: result.transactionId, walletId: input.walletId, providerId: input.providerId,
          correlationId: result.transactionId, status: result.status, durationMs: performance.now()-started });
        return result;
      }
      catch (error) {
        if (!(error instanceof RetryableFinancialTransactionError) || attempt >= 3) throw error;
        count('transaction_retries');
        // Bounded backoff outside the transaction: fresh EM/entities/locks on the next attempt.
        await new Promise<void>(resolve => setTimeout(resolve, 10 * attempt));
      }
    }
  }

  /** Composition point for a future Inbox boundary. Result is provisional until its owner commits.
   * Caller must retry the ENTIRE boundary, including Inbox, on a retryable failure. */
  processInTransaction(input: WagerInput, repositories: FinancialRepositories): Promise<WagerResult> {
    return this.process(prepareWager(input), repositories);
  }

  /** Called only within the reference worker's durable job claim. No external I/O. */
  async resumeInTransaction(id: string, repos: FinancialRepositories, expire: boolean): Promise<WagerResult | null> {
    const candidate = await repos.transactions.findById(id);
    if (!candidate) throw new Error('Pending transaction disappeared');
    await repos.wagerAdmission.lock(candidate.providerId, candidate.idempotencyKey, candidate.externalTransactionId);
    const tx = (await repos.transactions.findById(id))!;
    if (tx.isTerminal()) {
      const result = await repos.wagerResults.findByTransactionId(id);
      if (!result) throw new Error('Terminal transaction has no historical result');
      return Object.freeze({ ...result, idempotentReplay: true });
    }
    if (tx.status !== WagerTransactionStatus.PendingReference) throw new Error('Only pending references can resume');
    const wallet = await repos.wallets.findByIdForUpdate(tx.walletId);
    if (!wallet) throw new Error('Pending wallet disappeared');
    return this.settle(tx, wallet, repos, this.clock.now(), true, expire);
  }

  private async process(prepared: PreparedWager, repos: FinancialRepositories): Promise<WagerResult> {
    const { input, money, payloadHash } = prepared;
    await repos.wagerAdmission.lock(input.providerId, input.idempotencyKey, input.externalTransactionId);
    const existing = await repos.transactions.findByIdempotencyKey(input.providerId, input.idempotencyKey);
    if (existing) {
      if (!existing.matchesPayload(payloadHash)) throw new WagerProcessingError('IDEMPOTENCY_CONFLICT', 'Idempotency key is already bound to a different payload');
      const original = existing.status === WagerTransactionStatus.PendingReference
        ? await repos.wagerResults.findPendingReceipt(existing.id)
        : await repos.wagerResults.findByTransactionId(existing.id);
      if (!original || original.status !== existing.status) {
        throw new WagerProcessingError('ORIGINAL_RESULT_UNAVAILABLE', 'Existing operation has no compatible original result');
      }
      return Object.freeze({ ...original, idempotentReplay: true });
    }
    if (await repos.transactions.findByExternalId(input.providerId, input.externalTransactionId)) {
      throw new WagerProcessingError('EXTERNAL_TRANSACTION_CONFLICT', 'External transaction identity already exists with another idempotency key');
    }
    const wallet = await repos.wallets.findByIdForUpdate(input.walletId);
    if (!wallet) throw new WagerProcessingError('WALLET_NOT_FOUND', 'Wallet does not exist');
    if (wallet.playerId !== input.playerId) throw new WagerProcessingError('WALLET_PLAYER_MISMATCH', 'Player does not own this wallet');
    if (wallet.currency !== money.currency) throw new WagerProcessingError('WALLET_CURRENCY_MISMATCH', 'Operation currency differs from wallet currency');

    const at = this.clock.now();
    const tx = WagerTransaction.create({ ...input, kind: input.kind as WagerTransactionKind, money,
      id: this.ids.next(), payloadHash, createdAt: at });
    await repos.transactions.insert(tx); // Initial PENDING; this call persists a terminal result or a pending-reference receipt.
    return (await this.settle(tx, wallet, repos, at))!;
  }

  private async settle(tx: WagerTransaction, wallet: Wallet, repos: FinancialRepositories, at: Date,
    resuming = false, expire = false): Promise<WagerResult | null> {
    // No reference identity lock after the wallet: preserve admission order.
    const reference = tx.referenceExternalTransactionId === undefined ? undefined
      : (await repos.transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId)) ?? undefined;
    const previous = tx.requiresReference() && reference ? await repos.transactions.findProcessedReversal(reference.id) : null;
    const movement = this.apply(tx, wallet, reference, at, previous);
    if (resuming && tx.status === WagerTransactionStatus.PendingReference) {
      if (!expire) return null;
      tx.reject(FailureCode.ReferenceNotFound);
    }
    if (movement) await repos.wallets.save(wallet);
    await repos.transactions.updateLifecycle(tx);
    if (movement) await repos.ledger.insert(movement.entry, movement.walletVersion);
    const context = { correlationId: tx.id, causationId: tx.id, occurredAt: at };
    const event = tx.status === WagerTransactionStatus.PendingReference
      ? WagerTransactionPendingReference.from(tx, { ...context, eventId: this.ids.next() })
      : tx.status === WagerTransactionStatus.Processed
      ? WagerTransactionProcessed.from(tx, { ...context, eventId: this.ids.next() })
      : WagerTransactionRejected.from(tx, { ...context, eventId: this.ids.next() });
    await repos.outbox.insert(OutboxMessage.enqueue(event));
    if (movement) await repos.outbox.insert(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, movement.entry,
      { ...context, eventId: this.ids.next() })));
    if (tx.status === WagerTransactionStatus.PendingReference) {
      const receipt: PendingWagerReceipt = Object.freeze({ transactionId: tx.id, status: tx.status, balance: Object.freeze(wallet.balance.toJSON()) });
      await repos.wagerResults.insertPendingReceipt(receipt, wallet.version);
      return Object.freeze({ ...receipt, idempotentReplay: false });
    }
    if (tx.status !== WagerTransactionStatus.Processed && tx.status !== WagerTransactionStatus.Rejected) {
      throw new Error('Unexpected wager outcome');
    }
    const result: WagerResultSnapshot = Object.freeze({ transactionId: tx.id,
      status: tx.status,
      balance: Object.freeze(wallet.balance.toJSON()), ...(tx.failureCode === undefined ? {} : { failureCode: tx.failureCode }) });
    await repos.wagerResults.insert(result, wallet.version);
    return Object.freeze({ ...result, idempotentReplay: false });
  }

  /** Mutates only fresh domain objects. Persistence and event selection stay in the shared path. */
  private apply(tx: WagerTransaction, wallet: Wallet, reference: WagerTransaction | undefined, at: Date, previousRefund: WagerTransaction | null): WalletMovementResult | undefined {
    if (tx.kind === WagerTransactionKind.Win || tx.requiresReference()) {
      // Reuse domain reference validation before any credit.
      try {
        if (tx.requiresReference()) tx.assertReversalAvailable(reference, previousRefund);
        else tx.ledgerDirectionFor(reference);
      } catch (error) {
        if (!(error instanceof WagerTransactionError)) throw error;
        if (error.code === 'REFERENCE_REQUIRED' || error.code === 'REFERENCE_NOT_PROCESSED') {
          if (tx.status === WagerTransactionStatus.Pending) tx.markPendingReference();
        }
        else if (error.code === 'INVALID_REFERENCE') tx.reject(FailureCode.InvalidReference);
        else if (error.code === 'DUPLICATE_REVERSAL') tx.reject(FailureCode.DuplicateReversal);
        else throw error;
        return undefined;
      }
      const limit = Money.from({ amount: '999999999999999999.99', currency: wallet.currency });
      if (tx.ledgerDirectionFor(reference) === LedgerDirection.Credit && limit.isLessThan(wallet.balance.add(tx.money))) {
        tx.reject(FailureCode.DomainRuleViolation);
        return undefined;
      }
    }
    let movement: WalletMovementResult | undefined;
    if (tx.kind !== WagerTransactionKind.Loss) {
      const props = { money: tx.money, transactionId: tx.id, ledgerEntryId: this.ids.next(), at };
      try { movement = tx.ledgerDirectionFor(reference) === LedgerDirection.Debit ? wallet.debit(props) : wallet.credit(props); }
      catch (error) {
        if (!(error instanceof WalletError) || error.code !== 'INSUFFICIENT_FUNDS') throw error;
        tx.reject(tx.kind === WagerTransactionKind.Rollback ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds);
        return undefined;
      }
    }
    tx.markProcessed(reference, at);
    return movement;
  }
}
