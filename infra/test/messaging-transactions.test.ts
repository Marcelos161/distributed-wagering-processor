import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmOptions } from '../../src/infrastructure/persistence/orm-options.js';
import { MikroFinancialUnitOfWork } from '../../src/infrastructure/persistence/financial/financial-unit-of-work.js';
import { expect, test } from 'bun:test';
import { Wallet } from '../../src/domain/wallet/wallet.js';
import { Money } from '../../src/domain/money/money.js';
import type { InboxMessage } from '../../src/domain/messaging/inbox-message.js';
import type { OutboxMessage } from '../../src/domain/messaging/outbox-message.js';
import { messageAt, openingWithMessages, withMessagingDatabase } from './messaging-support.js';

test.each([true,false])('atomic opening persists outbox with broker inbox=%s', async withInbox => {
  await withMessagingDatabase(async ({ unit, app }) => {
    expect(await unit.run(repos => openingWithMessages(repos,'wallet','hash',withInbox))).toBe('applied');
    const [counts] = await app`SELECT (SELECT count(*)::text FROM wallets) AS wallets,(SELECT count(*)::text FROM wager_transactions) AS tx,
      (SELECT count(*)::text FROM wallet_ledger_entries) AS ledger,(SELECT count(*)::text FROM outbox_messages) AS outbox,
      (SELECT count(*)::text FROM inbox_messages WHERE processed_at IS NOT NULL) AS inbox`;
    expect(counts).toEqual({ wallets:'1',tx:'1',ledger:'1',outbox:'2',inbox:withInbox?'1':'0' });
    const due = await unit.run(repos => repos.outbox.listDue(messageAt,10));
    expect(due.map(item => item.id)).toEqual(['balance-wallet','processed-wallet']);
    expect(due[0]?.payload).toHaveProperty('data.money.amount','100.00');
    expect(due[0]?.occurredAt).toEqual(messageAt);
  });
},20_000);
test.each(['callback','commit'])('failure at %s rolls back financial rows inbox and outbox', async failure => {
  await withMessagingDatabase(async ({ unit, app }) => {
    let finished = false;
    const result = unit.run(async repos => {
      await openingWithMessages(repos);
      if (failure === 'callback') throw new Error('forced');
      const { wallet } = Wallet.open({ id:'invalid',playerId:'invalid',initialBalance:Money.from({amount:'1.00',currency:'BRL'}),at:messageAt,
        opening:{transactionId:'missing',ledgerEntryId:'missing'} });
      await repos.wallets.insert(wallet); finished = true;
    });
    if (failure === 'callback') await expect(result).rejects.toThrow('forced');
    else { await expect(result).rejects.toHaveProperty('code','23514'); expect(finished).toBe(true); }
    const [counts] = await app`SELECT (SELECT count(*)::text FROM wallets) AS wallets,(SELECT count(*)::text FROM wager_transactions) AS tx,
      (SELECT count(*)::text FROM wallet_ledger_entries) AS ledger,(SELECT count(*)::text FROM outbox_messages) AS outbox,(SELECT count(*)::text FROM inbox_messages) AS inbox`;
    expect(counts).toEqual({wallets:'0',tx:'0',ledger:'0',outbox:'0',inbox:'0'});
    expect(await unit.run(repos => openingWithMessages(repos))).toBe('applied');
  });
},20_000);
test('persistent replay has no second financial effect and divergent hash conflicts', async () => {
  await withMessagingDatabase(async ({ unit,app,appOrm,applicationUrl }) => {
    await unit.run(repos => openingWithMessages(repos));
    await appOrm.close();
    const restartedOrm = await MikroORM.init(createOrmOptions(applicationUrl));
    const restarted = new MikroFinancialUnitOfWork(restartedOrm);
    try {
    expect(await restarted.run(repos => openingWithMessages(repos))).toBe('replay');
    await expect(restarted.run(repos => openingWithMessages(repos,'wallet','different'))).rejects.toHaveProperty('code','INBOX_PAYLOAD_CONFLICT');
    expect((await app`SELECT count(*)::text AS n FROM wallet_ledger_entries`)[0].n).toBe('1');
    expect((await app`SELECT count(*)::text AS n FROM outbox_messages`)[0].n).toBe('2');
    } finally { await restartedOrm.close(); }
  });
},20_000);
test('pending inbox resumes and message objects cannot cross rollback boundary', async () => {
  await withMessagingDatabase(async ({ unit }) => {
    let dirty: InboxMessage | undefined;
    await unit.run(async repos => { await repos.inbox.receive({messageId:'message-wallet',consumerName:'test-consumer',payloadHash:'hash',receivedAt:messageAt}); });
    await expect(unit.run(async repos => {
      const result = await repos.inbox.receive({messageId:'message-wallet',consumerName:'test-consumer',payloadHash:'hash',receivedAt:messageAt});
      expect(result.disposition).toBe('pending'); dirty=result.message; dirty.markProcessed(messageAt); await repos.inbox.save(dirty); throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(dirty?.isProcessed()).toBe(true);
    await unit.run(async repos => { await expect(repos.inbox.save(dirty!)).rejects.toThrow('current transaction'); });
    expect(await unit.run(repos => openingWithMessages(repos))).toBe('applied');
  });
},20_000);
test('outbox rehydrates retry and publication and rejects stale read-only snapshots', async () => {
  await withMessagingDatabase(async ({ unit }) => {
    await unit.run(repos => openingWithMessages(repos));
    let old: OutboxMessage | undefined;
    await unit.run(async repos => {
      old=(await repos.outbox.findByIdForUpdate('balance-wallet'))!; old.scheduleRetry(messageAt); await repos.outbox.save(old);
      expect(await repos.outbox.findByIdForUpdate('absent')).toBeNull();
      await expect(repos.outbox.listDue(messageAt,0)).rejects.toThrow();
    });
    const later=new Date(messageAt.getTime()+1000);
    await unit.run(async repos => {
      expect((await repos.outbox.listDue(messageAt,10)).map(item=>item.id)).toEqual(['processed-wallet']);
      await expect(repos.outbox.save(old!)).rejects.toThrow('current transaction');
      const readonly=(await repos.outbox.listDue(later,10))[0]!;
      await expect(repos.outbox.save(readonly)).rejects.toThrow('current transaction');
      const fresh=(await repos.outbox.findByIdForUpdate('balance-wallet'))!;
      expect(fresh.attempts).toBe(1); expect(fresh.nextAttemptAt).toEqual(later);
      fresh.markPublished(later); await repos.outbox.save(fresh);
    });
    await unit.run(async repos => {
      expect((await repos.outbox.findByIdForUpdate('balance-wallet'))?.publishedAt).toEqual(later);
      expect(await repos.outbox.listDue(later,1)).toHaveLength(1);
    });
  });
},20_000);

test('all four event types survive JSONB mapping with stable type and version', async () => {
  const { WagerTransaction, WagerTransactionKind: Kind } = await import('../../src/domain/wagering/wager-transaction.js');
  const { FailureCode } = await import('../../src/domain/wagering/failure-code.js');
  const { WagerTransactionProcessed, WagerTransactionRejected, WagerTransactionPendingReference } = await import('../../src/domain/messaging/financial-events.js');
  const { OutboxMessage } = await import('../../src/domain/messaging/outbox-message.js');
  await withMessagingDatabase(async ({ unit }) => {
    await unit.run(async repos => {
      await openingWithMessages(repos);
      for (const kind of [Kind.Loss, Kind.Bet, Kind.Refund]) {
        const tx = WagerTransaction.create({ id: kind, providerId: 'provider', externalTransactionId: kind,
          idempotencyKey: kind, payloadHash: 'hash', walletId: 'wallet', playerId: 'player-wallet', roundId: 'round', gameId: 'game',
          kind, money: Money.from({amount: kind === Kind.Loss ? '0.00' : '10.00',currency:'BRL'}), createdAt: messageAt,
          ...(kind === Kind.Refund ? {referenceExternalTransactionId:'missing-bet'} : {}) });
        const ctx = {eventId:kind,correlationId:'correlation',occurredAt:messageAt};
        if(kind===Kind.Loss) tx.markProcessed(undefined,messageAt);
        else if(kind===Kind.Bet) tx.reject(FailureCode.InsufficientFunds);
        else tx.markPendingReference();
        await repos.transactions.insert(tx);
        const event=kind===Kind.Loss ? WagerTransactionProcessed.from(tx,ctx)
          : kind===Kind.Bet ? WagerTransactionRejected.from(tx,ctx) : WagerTransactionPendingReference.from(tx,ctx);
        await repos.outbox.insert(OutboxMessage.enqueue(event));
      }
    });
    await unit.run(async repos => {
      const due=await repos.outbox.listDue(messageAt,10);
      expect(new Set(due.map(message=>message.eventType)).size).toBe(4);
      expect(due).toHaveLength(5);
      for (const message of due) {
        expect(message.payload.eventId).toBe(message.id);
        expect(message.payload.version).toBe(1);
        expect(message.payload.occurredAt).toBe(messageAt.toISOString());
        expect(typeof (message.payload.data as {money:{amount:string}}).money.amount).toBe('string');
      }
      expect(await repos.ledger.listByWalletId('wallet')).toHaveLength(1);
    });
  });
},20_000);
