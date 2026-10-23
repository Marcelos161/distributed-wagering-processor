import { expect, test } from 'bun:test';
import { withFinancialDatabase, expectSqlState } from './financial-schema-support.js';

const payload = { eventId: 'event', aggregateId: 'tx', eventType: 'WagerTransactionProcessed', correlationId: 'c', version: 1,
  occurredAt: '2026-10-23T12:00:00.123Z', data: { transactionId: 'tx', walletId: 'w', playerId: 'p', providerId: 'p',
    externalTransactionId: 'external', roundId: 'r', gameId: 'g', kind: 'LOSS', status: 'PROCESSED', money: { amount: '0.00', currency: 'BRL' } } };
test('messaging migration is repeatable and reversible independently of financial tables', async () => {
  await withFinancialDatabase('Migration20261023000004', async ({ orm, app }) => {
    expect(await orm.migrator.up()).toEqual([]);
    await orm.migrator.down({ to: 'Migration20261023000003' });
    expect((await app`SELECT to_regclass('public.inbox_messages') AS inbox, to_regclass('public.wallets') AS wallets`)[0])
      .toEqual({ inbox: null, wallets: 'wallets' });
    await orm.migrator.up();
    expect((await app`SELECT count(*)::text AS n FROM outbox_messages`)[0].n).toBe('0');
  });
}, 20_000);
test('SQL enforces inbox uniqueness lifecycle and restricted permissions', async () => {
  await withFinancialDatabase('Migration20261023000004', async ({ app, owner }) => {
    await app`INSERT INTO inbox_messages VALUES ('consumer','message','hash','2026-10-23T12:00:00Z',NULL)`;
    await expectSqlState(() => app`INSERT INTO inbox_messages VALUES ('consumer','message','other','2026-10-23T12:00:00Z',NULL)`, '23505');
    await app`INSERT INTO inbox_messages VALUES ('other-consumer','message','hash','2026-10-23T12:00:00Z',NULL)`;
    await expectSqlState(() => app`UPDATE inbox_messages SET payload_hash='changed'`, '42501');
    await expectSqlState(() => owner`UPDATE inbox_messages SET payload_hash='changed'`, '23514');
    await app`UPDATE inbox_messages SET processed_at='2026-10-23T12:00:01Z' WHERE consumer_name='consumer'`;
    await expectSqlState(() => app`UPDATE inbox_messages SET processed_at=NULL WHERE consumer_name='consumer'`, '23514');
    await expectSqlState(() => app`DELETE FROM inbox_messages`, '42501');
  });
}, 20_000);
test('SQL validates outbox JSON money identity lifecycle and append-only envelope', async () => {
  await withFinancialDatabase('Migration20261023000004', async ({ app, owner }) => {
    const insert = (value: unknown, id = 'event') => app`INSERT INTO outbox_messages (id,aggregate_id,event_type,payload,occurred_at)
      VALUES (${id},'tx','WagerTransactionProcessed',${value},'2026-10-23T12:00:00.123Z')`;
    for (const bad of [{}, { ...payload, version: 2 }, { ...payload, data: { ...payload.data, money: { amount: 0, currency: 'BRL' } } },
      { ...payload, data: { ...payload.data, money: { amount: '0.001', currency: 'BRL' } } }]) await expectSqlState(() => insert(bad), '23514');
    await expectSqlState(() => insert(payload, 'different'), '23514');
    await insert(payload); await expectSqlState(() => insert(payload), '23505');
    await expectSqlState(() => app`UPDATE outbox_messages SET payload='{}'::jsonb`, '42501');
    await expectSqlState(() => owner`UPDATE outbox_messages SET payload='{}'::jsonb`, '23514');
    await expectSqlState(() => app`UPDATE outbox_messages SET attempts=-1`, '23514');
    await app`UPDATE outbox_messages SET attempts=1,next_attempt_at='2026-10-23T12:00:01.123Z'`;
    await app`UPDATE outbox_messages SET published_at='2026-10-23T12:00:01.123Z',next_attempt_at=NULL`;
    await expectSqlState(() => app`UPDATE outbox_messages SET published_at=NULL`, '23514');
    await expectSqlState(() => app`TRUNCATE outbox_messages`, '42501');
  });
}, 20_000);
