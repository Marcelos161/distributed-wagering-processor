import { expect, test } from 'bun:test';
import { expectSqlState, insertTransaction, insertWallet, withFinancialDatabase, type TransactionFixture } from './financial-schema-support.js';

const migration = 'Migration20261023000002';

test('wager identities and idempotency are independently unique within each provider', async () => {
  await withFinancialDatabase(migration, async ({ app }) => {
    await insertWallet(app);
    await insertTransaction(app);
    for (const patch of [{ id: 'bet-1' }, { id: 'other', external: 'bet-1' }, { id: 'other', key: 'bet-1' }]) {
      await expectSqlState(() => insertTransaction(app, patch), '23505');
    }
    await insertTransaction(app, { id: 'other-provider', provider: 'provider-b', external: 'bet-1', key: 'bet-1' });
    expect((await app`SELECT count(*)::text AS count FROM wager_transactions`)[0].count).toBe('2');
  });
});

test('wager wallet FK binds wallet, player and currency and prevents missing or mismatched owners', async () => {
  await withFinancialDatabase(migration, async ({ app }) => {
    await insertWallet(app);
    for (const patch of [{ wallet: 'missing' }, { player: 'another' }, { currency: 'USD' }, { currency: 'JPY' }]) {
      await expectSqlState(() => insertTransaction(app, patch), '23503');
    }
  });
});

test('wager permits unresolved external references while enforcing lifecycle and failure code shape', async () => {
  await withFinancialDatabase(migration, async ({ app }) => {
    await insertWallet(app);
    await insertTransaction(app, { id: 'refund', kind: 'REFUND', externalReference: 'not-arrived', status: 'PENDING_REFERENCE' });
    const invalid: Array<Partial<TransactionFixture>> = [
      { kind: 'OTHER' }, { status: 'OTHER' }, { kind: 'LOSS', amount: '1.00' }, { amount: '0.00' },
      { kind: 'REFUND' }, { externalReference: 'unexpected' }, { kind: 'WIN', externalReference: 'bet-1' },
      { status: 'PENDING_REFERENCE' }, { status: 'PROCESSED', processedAt: null },
      { processedAt: '2026-10-23T12:01:00Z' }, { status: 'REJECTED' },
      { status: 'FAILED', failure: 'INSUFFICIENT_FUNDS' }, { status: 'REJECTED', failure: 'IDEMPOTENCY_CONFLICT' },
      { status: 'REJECTED', failure: 'REVERSAL_INSUFFICIENT_FUNDS' }, { failure: 'DOMAIN_RULE_VIOLATION' },
    ];
    for (const patch of invalid) await expectSqlState(() => insertTransaction(app, patch), '23514');
    await app`UPDATE wager_transactions SET status='REJECTED', failure_code='REFERENCE_NOT_FOUND' WHERE id='refund'`;
    expect((await app`SELECT reference_transaction_id AS ref FROM wager_transactions`)[0].ref).toBeNull();
  });
});

test('wager validates processed references and full reversal amounts through direct SQL', async () => {
  await withFinancialDatabase(migration, async ({ app }) => {
    await insertWallet(app);
    await insertTransaction(app, { status: 'PROCESSED' });
    await insertTransaction(app, { id: 'pending-bet' });
    const valid = { id: 'refund', kind: 'REFUND', externalReference: 'bet-1', reference: 'bet-1', status: 'PROCESSED' };
    for (const patch of [{ amount: '24.99' }, { provider: 'provider-b' }, { round: 'other' },
      { externalReference: 'other' }, { externalReference: 'pending-bet', reference: 'pending-bet' }]) {
      await expectSqlState(() => insertTransaction(app, { ...valid, ...patch }), '23514');
    }
    await expectSqlState(() => insertTransaction(app, { ...valid, reference: 'missing' }), '23503');
    await insertTransaction(app, valid);
    await insertTransaction(app, { id: 'win', kind: 'WIN', amount: '99.99', externalReference: 'bet-1', reference: 'bet-1', status: 'PROCESSED' });
    await expectSqlState(() => insertTransaction(app, { ...valid, id: 'refund-win', externalReference: 'win', reference: 'win', amount: '99.99' }), '23514');
  });
});

test('successful reversal uniqueness permits rejected attempts and different reversal kinds', async () => {
  await withFinancialDatabase(migration, async ({ app }) => {
    await insertWallet(app);
    await insertTransaction(app, { status: 'PROCESSED' });
    await insertTransaction(app, { id: 'rejected', kind: 'REFUND', externalReference: 'bet-1', status: 'REJECTED', failure: 'INVALID_REFERENCE' });
    const valid = { kind: 'REFUND', externalReference: 'bet-1', reference: 'bet-1', status: 'PROCESSED' };
    await insertTransaction(app, { ...valid, id: 'refund' });
    await expectSqlState(() => insertTransaction(app, { ...valid, id: 'duplicate' }), '23505');
    await insertTransaction(app, { ...valid, id: 'rollback', kind: 'ROLLBACK' });
  });
});

test('unique reversal index arbitrates genuinely concurrent PostgreSQL insertions', async () => {
  await withFinancialDatabase(migration, async ({ app }) => {
    await insertWallet(app);
    await insertTransaction(app, { status: 'PROCESSED' });
    const results = await Promise.allSettled(['first', 'second'].map((id) =>
      insertTransaction(app, { id, kind: 'REFUND', externalReference: 'bet-1', reference: 'bet-1', status: 'PROCESSED' })));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((result) => result.status === 'rejected');
    expect(failed?.status === 'rejected' && failed.reason.errno).toBe('23505');
    expect((await app`SELECT count(*)::text AS count FROM wager_transactions WHERE kind='REFUND'`)[0].count).toBe('1');
  });
});

test('wager transition guard protects identities and terminal rows even with owner SQL privileges', async () => {
  await withFinancialDatabase(migration, async ({ app, owner }) => {
    await insertWallet(app);
    await insertTransaction(app, { kind: 'WIN', externalReference: 'missing' });
    await expectSqlState(() => owner`UPDATE wager_transactions SET amount='10.00'`, '23514');
    await app`UPDATE wager_transactions SET status='PENDING_REFERENCE'`;
    await expectSqlState(() => app`UPDATE wager_transactions SET status='PENDING'`, '23514');
    await expectSqlState(() => app`UPDATE wager_transactions SET status='PENDING_REFERENCE'`, '23514');
    await app`UPDATE wager_transactions SET status='FAILED', failure_code='PERMANENT_INFRASTRUCTURE_FAILURE'`;
    await expectSqlState(() => owner`UPDATE wager_transactions SET status='FAILED'`, '23514');
    await expectSqlState(() => owner`DELETE FROM wager_transactions`, '23514');
    await expectSqlState(() => app`UPDATE wager_transactions SET payload_hash='changed'`, '42501');
    await expectSqlState(() => app`TRUNCATE wager_transactions`, '42501');
  });
});

test('wager indexes exist and migration down preserves wallet before clean reapplication', async () => {
  await withFinancialDatabase(migration, async ({ owner, orm }) => {
    const indexes = await owner<Array<{ indexname: string }>>`SELECT indexname FROM pg_indexes WHERE tablename='wager_transactions'`;
    expect(indexes.map((row) => row.indexname)).toContain('wager_pending_reference_idx');
    expect(indexes.map((row) => row.indexname)).toContain('wager_successful_reversal_unique');
    expect(await orm.migrator.up({ to: migration })).toHaveLength(0);
    await orm.migrator.down();
    expect((await owner`SELECT to_regclass('wager_transactions') AS name`)[0].name).toBeNull();
    expect((await owner`SELECT to_regclass('wallets')::text AS name`)[0].name).toBe('wallets');
    await orm.migrator.up({ to: migration });
    expect(await orm.migrator.getExecuted()).toHaveLength(2);
  });
});
