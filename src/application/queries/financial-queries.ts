import type { FinancialUnitOfWork } from '../ports/financial-persistence.js';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction.js';
import { Money } from '../../domain/money/money.js';
import { LedgerDirection } from '../../domain/wallet/wallet-ledger-entry.js';

export class ResourceNotFoundError extends Error { readonly code = 'NOT_FOUND'; }
export class InvalidCursorError extends Error { readonly code = 'INVALID_CURSOR'; }
export class FinancialQueries {
  constructor(private readonly unit: FinancialUnitOfWork) {}
  async wallet(id: string) {
    return this.unit.run(async repos => {
      const wallet = await repos.wallets.findById(id);
      if (!wallet) throw new ResourceNotFoundError();
      return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
    });
  }
  async transaction(id: string, providerId?: string) {
    return this.unit.run(async repos => {
      const tx = providerId === undefined ? await repos.transactions.findById(id) : await repos.transactions.findByExternalId(providerId, id);
      if (!tx) throw new ResourceNotFoundError();
      return transactionView(tx);
    });
  }
  async ledger(walletId: string, cursor: string | undefined, limit = 50) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new InvalidCursorError();
    let after = 0;
    if (cursor !== undefined) {
      try {
        if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
        const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (!Array.isArray(decoded) || decoded.length !== 3 || decoded[0] !== 1 || decoded[1] !== walletId || !Number.isSafeInteger(decoded[2]) || decoded[2] < 1) throw new Error();
        after = decoded[2] as number;
      } catch { throw new InvalidCursorError(); }
    }
    return this.unit.run(async repos => {
      if (!await repos.wallets.findById(walletId)) throw new ResourceNotFoundError();
      const rows = await repos.ledger.pageByWalletId(walletId, after, limit + 1), items = rows.slice(0, limit);
      return { items: items.map(({ entry: e, walletVersion }) => ({ id: e.id, walletId: e.walletId, transactionId: e.transactionId,
        walletVersion, direction: e.direction, money: e.money.toJSON(), balanceBefore: e.balanceBefore.toJSON(), balanceAfter: e.balanceAfter.toJSON(), createdAt: e.createdAt.toISOString() })),
        nextCursor: rows.length > limit ? Buffer.from(JSON.stringify([1, walletId, items.at(-1)!.walletVersion])).toString('base64url') : null };
    });
  }
  async reconcile(walletId: string) {
    return this.unit.run(async repos => {
      const wallet = await repos.wallets.findByIdForUpdate(walletId);
      if (!wallet) throw new ResourceNotFoundError();
      const entries = await repos.ledger.listByWalletId(walletId), transactions = await repos.transactions.listByWalletId(walletId);
      const byId = new Map(transactions.map(tx => [tx.id, tx])), seen = new Set<string>(), issues: string[] = [];
      let calculated = Money.zero(wallet.currency), version = 0;
      for (const { entry: e, walletVersion } of entries) {
        if (seen.has(e.transactionId)) issues.push('DUPLICATE_TRANSACTION'); seen.add(e.transactionId);
        if (walletVersion !== (version === 0 ? (walletVersion === 1 ? 1 : 2) : version + 1)) issues.push('VERSION_GAP');
        if (!e.balanceBefore.equals(calculated) || !e.isBalanced()) issues.push('BALANCE_CHAIN');
        const tx = byId.get(e.transactionId);
        const reference = tx?.referenceTransactionId ? byId.get(tx.referenceTransactionId) : undefined;
        if (!tx || tx.status !== 'PROCESSED' || !tx.money.equals(e.money) || tx.ledgerDirectionFor(reference) !== e.direction) issues.push('TRANSACTION_MISMATCH');
        calculated = e.direction === LedgerDirection.Credit ? calculated.add(e.money) : calculated.subtract(e.money);
        if (calculated.isNegative() || !e.balanceAfter.equals(calculated)) issues.push('BALANCE_AFTER');
        version = walletVersion;
      }
      for (const tx of transactions) if (tx.status === 'PROCESSED' && tx.kind !== 'LOSS' && !seen.has(tx.id)) issues.push('MISSING_LEDGER');
      if (wallet.version !== (version || 1)) issues.push('WALLET_VERSION');
      const difference = wallet.balance.subtract(calculated);
      if (!difference.isZero()) issues.push('BALANCE_DIFFERENCE');
      return { walletId, storedBalance: wallet.balance.toJSON(), calculatedBalance: calculated.toJSON(), difference: difference.toJSON(),
        consistent: issues.length === 0, checkedEntries: entries.length, issues: [...new Set(issues)] };
    });
  }
}
function transactionView(tx: WagerTransaction) {
  return { id: tx.id, providerId: tx.providerId, externalTransactionId: tx.externalTransactionId, walletId: tx.walletId, playerId: tx.playerId,
    roundId: tx.roundId, gameId: tx.gameId, kind: tx.kind, money: tx.money.toJSON(), status: tx.status,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null, referenceTransactionId: tx.referenceTransactionId ?? null,
    failureCode: tx.failureCode ?? null, createdAt: tx.createdAt.toISOString(), processedAt: tx.processedAt?.toISOString() ?? null };
}
