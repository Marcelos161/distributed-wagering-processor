import { MikroORM } from '@mikro-orm/postgresql';
import type { FinancialRepositories } from '../../src/application/ports/financial-persistence.js';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message.js';
import { WalletBalanceChanged, WagerTransactionProcessed } from '../../src/domain/messaging/financial-events.js';
import { createOrmOptions } from '../../src/infrastructure/persistence/orm-options.js';
import { MikroFinancialUnitOfWork } from '../../src/infrastructure/persistence/financial/financial-unit-of-work.js';
import { withFinancialDatabase, type FinancialDatabase } from './financial-schema-support.js';
import { persistOpening } from './persistence-support.js';
export const messageAt = new Date('2026-10-23T12:00:00.123Z');
export async function withMessagingDatabase(run: (db: FinancialDatabase & { appOrm: MikroORM; unit: MikroFinancialUnitOfWork }) => Promise<void>): Promise<void> {
  await withFinancialDatabase('Migration20261023000004', async db => {
    const appOrm = await MikroORM.init(createOrmOptions(db.applicationUrl));
    try { await run({ ...db, appOrm, unit: new MikroFinancialUnitOfWork(appOrm) }); } finally { await appOrm.close(); }
  });
}
/** Fixture only, not a public financial handler. */
export async function openingWithMessages(repos: FinancialRepositories, id = 'wallet', hash = 'hash', withInbox = true): Promise<'applied' | 'replay'> {
  const received = withInbox ? await repos.inbox.receive({ messageId: `message-${id}`, consumerName: 'test-consumer', payloadHash: hash, receivedAt: messageAt }) : undefined;
  if (received?.disposition === 'processed') return 'replay';
  const wallet = await persistOpening(repos, id);
  const tx = (await repos.transactions.findById(`opening-${id}`))!;
  const [entry] = await repos.ledger.listByWalletId(id);
  const context = { correlationId: `correlation-${id}`, causationId: `message-${id}`, occurredAt: messageAt };
  await repos.outbox.insert(OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, { ...context, eventId: `processed-${id}` })));
  await repos.outbox.insert(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry!.entry, { ...context, eventId: `balance-${id}` })));
  if (received) { received.message.markProcessed(messageAt); await repos.inbox.save(received.message); }
  return 'applied';
}
