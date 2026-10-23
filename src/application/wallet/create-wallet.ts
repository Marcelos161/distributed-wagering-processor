import { createHash } from 'node:crypto';
import type { FinancialUnitOfWork } from '../ports/financial-persistence.js';
import type { Clock, IdGenerator } from '../ports/runtime.js';
import { Money, type MoneyProps } from '../../domain/money/money.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import { WagerTransaction } from '../../domain/wagering/wager-transaction.js';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../../domain/messaging/financial-events.js';
import { OutboxMessage } from '../../domain/messaging/outbox-message.js';

export interface CreateWalletInput {
  readonly playerId: string;
  readonly initialBalance: Readonly<MoneyProps>;
}
export interface CreatedWallet {
  readonly id: string;
  readonly playerId: string;
  readonly balance: Readonly<MoneyProps>;
  readonly version: number;
}

export class CreateWallet {
  constructor(
    private readonly unit: FinancialUnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(input: CreateWalletInput): Promise<CreatedWallet> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Wallet input must be an object');
    const { playerId } = input;
    if (typeof playerId !== 'string' || !playerId || /[\s\u0000-\u001f\u007f]/u.test(playerId)) {
      throw new TypeError('playerId must be a non-empty identifier without whitespace or control characters');
    }
    const balance = Money.from(input.initialBalance);
    // Admission limit for the current storage contract; Money itself remains unbounded.
    if (Money.from({ amount: '999999999999999999.99', currency: balance.currency }).isLessThan(balance)) {
      throw new RangeError('Initial balance exceeds the financial storage limit');
    }
    const at = this.clock.now();
    // The UOW resolves only after COMMIT (including deferred constraint checks).
    return this.unit.run(async repos => {
      const id = this.ids.next();
      const opening = balance.isPositive()
        ? { transactionId: this.ids.next(), ledgerEntryId: this.ids.next() } : undefined;
      const { wallet, openingEntry } = Wallet.open({ id, playerId, initialBalance: balance, at,
        ...(opening === undefined ? {} : { opening }) });
      await repos.wallets.insert(wallet);
      if (openingEntry !== null) {
        const tx = WagerTransaction.createOpening({
          id: openingEntry.transactionId, providerId: 'internal:wallet-opening',
          externalTransactionId: openingEntry.transactionId, idempotencyKey: openingEntry.transactionId,
          payloadHash: openingPayloadHash(wallet, openingEntry.transactionId, openingEntry.id),
          walletId: wallet.id, playerId: wallet.playerId, roundId: 'wallet-opening', gameId: 'wallet-opening',
          money: wallet.balance, createdAt: wallet.createdAt,
        });
        tx.markProcessed(undefined, wallet.createdAt);
        await repos.transactions.insert(tx);
        await repos.ledger.insert(openingEntry, wallet.version);
        const context = { correlationId: wallet.id, causationId: tx.id, occurredAt: wallet.createdAt };
        await repos.outbox.insert(OutboxMessage.enqueue(WagerTransactionProcessed.from(tx,
          { ...context, eventId: this.ids.next() })));
        await repos.outbox.insert(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry,
          { ...context, eventId: this.ids.next() })));
      }
      return Object.freeze({ id: wallet.id, playerId: wallet.playerId,
        balance: Object.freeze(wallet.balance.toJSON()), version: wallet.version });
    });
  }
}

/** Fixed field order and normalized decimal/UTC values: canonical only for OPENING v1. */
function openingPayloadHash(wallet: Wallet, transactionId: string, ledgerEntryId: string): string {
  const canonical = JSON.stringify({ version: 1, kind: 'OPENING', providerId: 'internal:wallet-opening',
    transactionId, externalTransactionId: transactionId, idempotencyKey: transactionId,
    walletId: wallet.id, playerId: wallet.playerId, ledgerEntryId,
    roundId: 'wallet-opening', gameId: 'wallet-opening',
    money: wallet.balance.toJSON(), createdAt: wallet.createdAt.toISOString() });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
