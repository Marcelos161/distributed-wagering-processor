import type { FinancialRepositories, FinancialUnitOfWork } from '../ports/financial-persistence.js';
import type { Clock, IdGenerator } from '../ports/runtime.js';
import { RetryableFinancialTransactionError } from '../errors/retryable-financial-transaction-error.js';
import { prepareBet, type BetInput, type PreparedBet } from './prepare-bet.js';
import { WagerProcessingError } from './wager-processing-error.js';
import type { WagerResult, WagerResultSnapshot } from './wager-result.js';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../domain/wagering/wager-transaction.js';
import { FailureCode } from '../../domain/wagering/failure-code.js';
import { WalletError } from '../../domain/wallet/wallet-error.js';
import type { WalletMovementResult } from '../../domain/wallet/wallet.js';
import { WagerTransactionProcessed, WagerTransactionRejected, WalletBalanceChanged } from '../../domain/messaging/financial-events.js';
import { OutboxMessage } from '../../domain/messaging/outbox-message.js';

export class ProcessWagerTransaction {
  constructor(private readonly unit: FinancialUnitOfWork, private readonly ids: IdGenerator, private readonly clock: Clock) {}

  async execute(input: BetInput): Promise<WagerResult> {
    const prepared = prepareBet(input);
    for (let attempt = 1; ; attempt++) {
      try { return await this.unit.run(repos => this.process(prepared, repos)); }
      catch (error) {
        if (!(error instanceof RetryableFinancialTransactionError) || attempt >= 3) throw error;
        // Bounded backoff outside the transaction: fresh EM/entities/locks on the next attempt.
        await new Promise<void>(resolve => setTimeout(resolve, 10 * attempt));
      }
    }
  }

  /** Composition point for a future Inbox boundary. Result is provisional until its owner commits.
   * Caller must retry the ENTIRE boundary, including Inbox, on a retryable failure. */
  processInTransaction(input: BetInput, repositories: FinancialRepositories): Promise<WagerResult> {
    return this.process(prepareBet(input), repositories);
  }

  private async process(prepared: PreparedBet, repos: FinancialRepositories): Promise<WagerResult> {
    const { input, money, payloadHash } = prepared;
    await repos.wagerAdmission.lock(input.providerId, input.idempotencyKey, input.externalTransactionId);
    const existing = await repos.transactions.findByIdempotencyKey(input.providerId, input.idempotencyKey);
    if (existing) {
      if (!existing.matchesPayload(payloadHash)) throw new WagerProcessingError('IDEMPOTENCY_CONFLICT', 'Idempotency key is already bound to a different payload');
      const original = await repos.wagerResults.findByTransactionId(existing.id);
      if (!original || original.status !== existing.status) {
        throw new WagerProcessingError('ORIGINAL_RESULT_UNAVAILABLE', 'Existing operation has no compatible original terminal result');
      }
      return Object.freeze({ ...original, idempotentReplay: true });
    }
    if (await repos.transactions.findByExternalId(input.providerId, input.externalTransactionId)) {
      throw new WagerProcessingError('EXTERNAL_TRANSACTION_CONFLICT', 'External transaction identity already exists with another idempotency key');
    }
    const wallet = await repos.wallets.findByIdForUpdate(input.walletId);
    if (!wallet) throw new WagerProcessingError('WALLET_NOT_FOUND', 'Wallet does not exist');
    if (wallet.playerId !== input.playerId) throw new WagerProcessingError('WALLET_PLAYER_MISMATCH', 'Player does not own this wallet');
    if (wallet.currency !== money.currency) throw new WagerProcessingError('WALLET_CURRENCY_MISMATCH', 'BET currency differs from wallet currency');

    const at = this.clock.now();
    const tx = WagerTransaction.create({ ...input, kind: WagerTransactionKind.Bet, money,
      id: this.ids.next(), payloadHash, createdAt: at });
    await repos.transactions.insert(tx); // PENDING; terminal outcome and result are required before commit.
    let movement: WalletMovementResult | undefined;
    try {
      movement = wallet.debit({ money, transactionId: tx.id, ledgerEntryId: this.ids.next(), at });
    } catch (error) {
      if (!(error instanceof WalletError) || error.code !== 'INSUFFICIENT_FUNDS') throw error;
      tx.reject(FailureCode.InsufficientFunds);
    }
    if (movement) {
      tx.markProcessed(undefined, at);
      await repos.wallets.save(wallet);
      await repos.transactions.updateLifecycle(tx);
      await repos.ledger.insert(movement.entry, movement.walletVersion);
    } else {
      await repos.transactions.updateLifecycle(tx);
    }
    const context = { correlationId: tx.id, causationId: tx.id, occurredAt: at };
    const event = movement
      ? WagerTransactionProcessed.from(tx, { ...context, eventId: this.ids.next() })
      : WagerTransactionRejected.from(tx, { ...context, eventId: this.ids.next() });
    await repos.outbox.insert(OutboxMessage.enqueue(event));
    if (movement) await repos.outbox.insert(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, movement.entry,
      { ...context, eventId: this.ids.next() })));
    const result: WagerResultSnapshot = Object.freeze({ transactionId: tx.id,
      status: movement ? WagerTransactionStatus.Processed : WagerTransactionStatus.Rejected,
      balance: Object.freeze(wallet.balance.toJSON()), ...(tx.failureCode === undefined ? {} : { failureCode: tx.failureCode }) });
    await repos.wagerResults.insert(result, wallet.version);
    return Object.freeze({ ...result, idempotentReplay: false });
  }
}
