import { MikroORM } from '@mikro-orm/postgresql';
import type { FinancialRepositories } from '../../src/application/ports/financial-persistence.js';
import { Money } from '../../src/domain/money/money.js';
import { Wallet } from '../../src/domain/wallet/wallet.js';
import { WagerTransaction, WagerTransactionKind } from '../../src/domain/wagering/wager-transaction.js';
import { createOrmOptions } from '../../src/infrastructure/persistence/orm-options.js';
import { FinancialSession } from '../../src/infrastructure/persistence/financial/financial-session.js';
import { createRepositories } from '../../src/infrastructure/persistence/financial/create-repositories.js';
import { withFinancialDatabase, type FinancialDatabase } from './financial-schema-support.js';

export async function withPersistenceDatabase(run: (database: FinancialDatabase & { appOrm: MikroORM }) => Promise<void>): Promise<void> {
  await withFinancialDatabase('Migration20261023000003', async (database) => {
    const appOrm = await MikroORM.init(createOrmOptions(database.applicationUrl));
    try { await run({ ...database, appOrm }); } finally { await appOrm.close(); }
  });
}

/** Low-level repository tests use the official transaction API directly. */
export async function inRepositoryTransaction<T>(orm: MikroORM, work: (repos: FinancialRepositories) => Promise<T>): Promise<T> {
  return orm.em.fork({ clear: true, useContext: false }).transactional(async (em) => {
    const session = new FinancialSession(em);
    try { return await work(createRepositories(session)); } finally { session.close(); }
  });
}

const at = new Date('2026-10-23T12:00:00.123Z');

/** Test fixture only: no public application use case and no event publication. */
export async function persistOpening(repos: FinancialRepositories, id = 'wallet-1', amount = '100.00'): Promise<Wallet> {
  const money = Money.from({ amount, currency: 'BRL' });
  const transaction = WagerTransaction.createOpening({ id: `opening-${id}`, providerId: 'internal',
    externalTransactionId: `opening-${id}`, idempotencyKey: `opening-${id}`, payloadHash: 'fixture-hash',
    walletId: id, playerId: `player-${id}`, roundId: 'opening', gameId: 'opening', money, createdAt: at });
  const { wallet, openingEntry } = Wallet.open({ id, playerId: `player-${id}`, initialBalance: money, at,
    opening: { ledgerEntryId: `entry-opening-${id}`, transactionId: transaction.id } });
  transaction.markProcessed(undefined, at);
  await repos.wallets.insert(wallet);
  await repos.transactions.insert(transaction);
  await repos.ledger.insert(openingEntry!, wallet.version);
  return wallet;
}

export async function persistCredit(repos: FinancialRepositories, wallet: Wallet, id: string, amount = '0.10'): Promise<void> {
  const money = Money.from({ amount, currency: wallet.currency });
  const transaction = WagerTransaction.create({ id, providerId: 'provider', externalTransactionId: id,
    idempotencyKey: id, payloadHash: 'fixture-hash', walletId: wallet.id, playerId: wallet.playerId,
    roundId: 'round', gameId: 'game', kind: WagerTransactionKind.Win, money, createdAt: at });
  await repos.transactions.insert(transaction);
  const movement = wallet.credit({ ledgerEntryId: `entry-${id}`, transactionId: id, money, at });
  await repos.wallets.save(wallet);
  transaction.markProcessed(undefined, at);
  await repos.transactions.updateLifecycle(transaction);
  await repos.ledger.insert(movement.entry, movement.walletVersion);
}
