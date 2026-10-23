import { expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { expectSqlState, insertLedger, insertTransaction, insertWallet, openFundedWallet,
  withFinancialDatabase, type LedgerFixture } from './financial-schema-support.js';

const migration = 'Migration20261023000003';

async function walletState(sql: SQL) {
  return sql`SELECT balance::text, version::text FROM wallets ORDER BY id`;
}

async function credit(sql: SQL, id = 'win-1', before = '100.00', after = '125.00', version = 2): Promise<void> {
  await insertTransaction(sql, { id, kind: 'WIN', status: 'PROCESSED' });
  await insertLedger(sql, { id: 'entry-' + id, transaction: id, before, after, version });
  await sql`UPDATE wallets SET balance=${after},version=${version},updated_at='2026-10-23T12:01:00Z' WHERE id='wallet-1'`;
}

test('full schema accepts zero opening without ledger and positive opening with its exact transaction and ledger', async () => {
  await withFinancialDatabase(migration, async ({ app }) => {
    await openFundedWallet(app);
    await insertWallet(app, 'empty');
    expect(await walletState(app)).toEqual([{ balance: '0.00', version: '1' }, { balance: '100.00', version: '1' }]);
    expect((await app`SELECT sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)::text AS balance FROM wallet_ledger_entries`)[0].balance).toBe('100.00');
  });
});

test('positive opening without ledger fails at commit and leaves no wallet', async () => {
  await withFinancialDatabase(migration, async ({ app }) => {
    await expectSqlState(() => insertWallet(app, 'unbacked', '100.00'), '23514');
    expect(await walletState(app)).toEqual([]);
  });
});

test('wallet cannot change balance alone, increment version alone or alter its immutable identity', async () => {
  await withFinancialDatabase(migration, async ({ app, owner }) => {
    await openFundedWallet(app);
    for (const query of ["UPDATE wallets SET balance='90.00',version=2", 'UPDATE wallets SET version=2',
      "UPDATE wallets SET balance='90.00'", "UPDATE wallets SET updated_at='2027-01-01'"]) {
      await expectSqlState(() => app.unsafe(query), '23514');
    }
    await expectSqlState(() => owner`UPDATE wallets SET player_id='changed'`, '23514');
    expect(await walletState(app)).toEqual([{ balance: '100.00', version: '1' }]);
  });
});

test('processed financial transaction without ledger fails, while LOSS, rejected and pending transactions need none', async () => {
  await withFinancialDatabase(migration, async ({ app }) => {
    await insertWallet(app);
    await expectSqlState(() => insertTransaction(app, { status: 'PROCESSED' }), '23514');
    await insertTransaction(app, { id: 'loss', kind: 'LOSS', amount: '0.00', status: 'PROCESSED' });
    await insertTransaction(app, { id: 'rejected', status: 'REJECTED', failure: 'INSUFFICIENT_FUNDS' });
    await insertTransaction(app, { id: 'pending' });
    expect((await app`SELECT count(*)::text AS count FROM wallet_ledger_entries`)[0].count).toBe('0');
    expect(await walletState(app)).toEqual([{ balance: '0.00', version: '1' }]);
  });
});

test('deferred checks allow ledger before status and wallet update within one transaction and reject incomplete commit', async () => {
  await withFinancialDatabase(migration, async ({ app }) => {
    await openFundedWallet(app);
    await expectSqlState(() => app.begin(async (sql) => {
      await insertTransaction(sql, { id: 'win-1', kind: 'WIN', status: 'PROCESSED' });
      await insertLedger(sql);
    }), '23514');
    expect((await app`SELECT count(*)::text AS count FROM wager_transactions`)[0].count).toBe('1');
    await app.begin(async (sql) => {
      await insertTransaction(sql, { id: 'win-1', kind: 'WIN' });
      await insertLedger(sql);
      await sql`UPDATE wallets SET balance='125.00',version=2`;
      await sql`UPDATE wager_transactions SET status='PROCESSED',processed_at='2026-10-23T12:01:00Z' WHERE id='win-1'`;
    });
    expect(await walletState(app)).toEqual([{ balance: '125.00', version: '2' }]);
  });
});

test('ledger enforces arithmetic, positive exact amounts, currency and all foreign keys', async () => {
  await withFinancialDatabase(migration, async ({ app }) => {
    await openFundedWallet(app);
    const invalid: Array<{ patch: Partial<LedgerFixture>; code: string }> = [
      { patch: { after: '124.99' }, code: '23514' }, { patch: { before: '-1.00' }, code: '23514' },
      { patch: { after: '-1.00' }, code: '23514' }, { patch: { amount: '0.00' }, code: '23514' },
      { patch: { amount: '1.005' }, code: '23514' }, { patch: { amount: '1000000000000000000.00' }, code: '23514' },
      { patch: { amount: 'NaN' }, code: '23514' }, { patch: { direction: 'OTHER' }, code: '23514' },
      { patch: { version: 0 }, code: '23514' }, { patch: { currency: 'USD' }, code: '23503' },
      { patch: { transaction: 'missing' }, code: '23503' }, { patch: { wallet: 'missing' }, code: '23503' },
    ];
    for (const { patch, code } of invalid) {
      await expectSqlState(() => app.begin(async (sql) => {
        await insertTransaction(sql, { id: 'win-1', kind: 'WIN' });
        await insertLedger(sql, patch);
      }), code);
    }
  });
});

test('ledger is immutable for app and owner and all financial TRUNCATE paths are blocked', async () => {
  await withFinancialDatabase(migration, async ({ app, owner }) => {
    await openFundedWallet(app);
    for (const query of ["UPDATE wallet_ledger_entries SET amount='99.00'", 'DELETE FROM wallet_ledger_entries', 'TRUNCATE wallet_ledger_entries']) {
      await expectSqlState(() => app.unsafe(query), '42501');
      await expectSqlState(() => owner.unsafe(query), '23514');
    }
    await expectSqlState(() => owner`TRUNCATE wallets CASCADE`, '23514');
    await expectSqlState(() => owner`TRUNCATE wager_transactions CASCADE`, '23514');
    await expectSqlState(() => owner`DELETE FROM wallets`, '23514');
    await expectSqlState(() => app`ALTER TABLE wallet_ledger_entries DISABLE TRIGGER ALL`, '42501');
    await expectSqlState(() => app`SET session_replication_role=replica`, '42501');
    expect((await app`SELECT count(*)::text AS count FROM wallet_ledger_entries`)[0].count).toBe('1');
  });
});

test('ledger uniqueness prevents a transaction or a wallet version from acquiring a second entry', async () => {
  await withFinancialDatabase(migration, async ({ app }) => {
    await openFundedWallet(app);
    await expectSqlState(() => insertLedger(app, { id: 'another', transaction: 'opening', version: 2,
      amount: '100.00', before: '100.00', after: '200.00' }), '23505');
    await expectSqlState(() => app.begin(async (sql) => {
      await insertTransaction(sql, { id: 'win-1', kind: 'WIN', status: 'PROCESSED' });
      await insertLedger(sql, { version: 1 });
    }), '23505');
  });
});

test('ledger rejects pending, rejected, failed and LOSS outcomes even with arithmetically valid entries', async () => {
  await withFinancialDatabase(migration, async ({ app }) => {
    await openFundedWallet(app);
    for (const status of ['PENDING', 'REJECTED', 'FAILED', 'PROCESSED']) {
      await expectSqlState(() => app.begin(async (sql) => {
        await insertTransaction(sql, { id: 'win-1', kind: status === 'PROCESSED' ? 'LOSS' : 'WIN', status,
          amount: status === 'PROCESSED' ? '0.00' : '25.00', failure: status === 'REJECTED' ? 'DOMAIN_RULE_VIOLATION'
            : status === 'FAILED' ? 'PERMANENT_INFRASTRUCTURE_FAILURE' : null });
        await insertLedger(sql);
        await sql`UPDATE wallets SET balance='125.00',version=2`;
      }), '23514');
    }
  });
});

test('ledger rejects mismatched transaction amount or debit direction for a WIN', async () => {
  await withFinancialDatabase(migration, async ({ app }) => {
    await openFundedWallet(app);
    for (const patch of [{ amount: '20.00', after: '120.00' }, { direction: 'DEBIT', after: '75.00' }]) {
      await expectSqlState(() => app.begin(async (sql) => {
        await insertTransaction(sql, { id: 'win-1', kind: 'WIN', status: 'PROCESSED' });
        await insertLedger(sql, patch);
        await sql`UPDATE wallets SET balance=${patch.after},version=2`;
      }), '23514');
    }
  });
});

test('wallet event checks prevent fabricating an inconsistent intermediate balance history', async () => {
  await withFinancialDatabase(migration, async ({ app }) => {
    await openFundedWallet(app);
    await expectSqlState(() => app.begin(async (sql) => {
      await insertTransaction(sql, { id: 'win-1', kind: 'WIN', status: 'PROCESSED' });
      await insertLedger(sql, { before: '90.00', after: '115.00' });
      await sql`UPDATE wallets SET balance='115.00',version=2`;
    }), '23514');
    await expectSqlState(() => app.begin(async (sql) => {
      await insertTransaction(sql, { id: 'win-1', kind: 'WIN', status: 'PROCESSED' });
      await insertLedger(sql, { version: 3 });
      await sql`UPDATE wallets SET balance='125.00',version=3`;
    }), '23514');
    expect(await walletState(app)).toEqual([{ balance: '100.00', version: '1' }]);
  });
});

test('multiple movements in one SQL transaction form a contiguous exact ledger chain', async () => {
  await withFinancialDatabase(migration, async ({ app }) => {
    await openFundedWallet(app);
    await app.begin(async (sql) => {
      await credit(sql);
      await credit(sql, 'win-2', '125.00', '150.00', 3);
    });
    expect(await walletState(app)).toEqual([{ balance: '150.00', version: '3' }]);
    expect((await app`SELECT sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)::text AS total FROM wallet_ledger_entries`)[0].total).toBe('150.00');
  });
});

test('first movement on a zero wallet starts at version two and cannot masquerade as OPENING', async () => {
  await withFinancialDatabase(migration, async ({ app }) => {
    await insertWallet(app);
    await expectSqlState(() => app.begin(async (sql) => {
      await insertTransaction(sql, { id: 'opening', kind: 'OPENING', amount: '25.00', status: 'PROCESSED' });
      await insertLedger(sql, { transaction: 'opening', before: '0.00', after: '25.00' });
      await sql`UPDATE wallets SET balance='25.00',version=2`;
    }), '23514');
    await app.begin(async (sql) => { await credit(sql, 'win-1', '0.00', '25.00', 2); });
    expect(await walletState(app)).toEqual([{ balance: '25.00', version: '2' }]);
  });
});

test('BET, REFUND and ROLLBACK of WIN or REFUND obey SQL reference direction and integral amounts', async () => {
  await withFinancialDatabase(migration, async ({ app }) => {
    await openFundedWallet(app);
    const movements = [
      { id: 'bet', kind: 'BET', before: '100.00', after: '75.00', direction: 'DEBIT', reference: null },
      { id: 'refund', kind: 'REFUND', before: '75.00', after: '100.00', direction: 'CREDIT', reference: 'bet' },
      { id: 'rollback-refund', kind: 'ROLLBACK', before: '100.00', after: '75.00', direction: 'DEBIT', reference: 'refund' },
      { id: 'rollback-bet', kind: 'ROLLBACK', before: '75.00', after: '100.00', direction: 'CREDIT', reference: 'bet' },
      { id: 'win', kind: 'WIN', before: '100.00', after: '125.00', direction: 'CREDIT', reference: 'bet' },
      { id: 'rollback-win', kind: 'ROLLBACK', before: '125.00', after: '100.00', direction: 'DEBIT', reference: 'win' },
    ];
    for (const [index, entry] of movements.entries()) {
      await app.begin(async (sql) => {
        await insertTransaction(sql, { id: entry.id, kind: entry.kind, status: 'PROCESSED',
          reference: entry.reference, externalReference: entry.reference });
        await insertLedger(sql, { ...entry, id: 'entry-' + entry.id, transaction: entry.id, version: index + 2 });
        await sql`UPDATE wallets SET balance=${entry.after},version=${index + 2}`;
      });
    }
    expect(await walletState(app)).toEqual([{ balance: '100.00', version: '7' }]);
  });
});

test('forced SQL failure rolls back wallet, transaction and ledger together', async () => {
  await withFinancialDatabase(migration, async ({ app }) => {
    await openFundedWallet(app);
    await expectSqlState(() => app.begin(async (sql) => {
      await credit(sql);
      await sql`SELECT 1/0`;
    }), '22012');
    expect(await walletState(app)).toEqual([{ balance: '100.00', version: '1' }]);
    expect((await app`SELECT count(*)::text AS count FROM wager_transactions`)[0].count).toBe('1');
    expect((await app`SELECT count(*)::text AS count FROM wallet_ledger_entries`)[0].count).toBe('1');
  });
});

test('SET CONSTRAINTS IMMEDIATE exposes an incomplete financial write before commit', async () => {
  await withFinancialDatabase(migration, async ({ app }) => {
    await openFundedWallet(app);
    await expectSqlState(() => app.begin(async (sql) => {
      await sql`UPDATE wallets SET balance='125.00',version=2`;
      await sql`SET CONSTRAINTS ALL IMMEDIATE`;
    }), '23514');
    expect(await walletState(app)).toEqual([{ balance: '100.00', version: '1' }]);
  });
});

test('all financial migrations reverse and reapply without leftover schema or duplicated history', async () => {
  await withFinancialDatabase(migration, async ({ owner, orm, app }) => {
    await openFundedWallet(app);
    expect(await orm.migrator.up({ to: migration })).toHaveLength(0);
    await orm.migrator.down({ to: 0 });
    expect(await owner`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)
      .toEqual([{ tablename: 'mikro_orm_migrations' }]);
    expect((await owner`SELECT count(*)::text AS count FROM pg_proc WHERE pronamespace='public'::regnamespace`)[0].count).toBe('0');
    await orm.migrator.up({ to: migration });
    expect(await orm.migrator.getExecuted()).toHaveLength(3);
    await openFundedWallet(app);
  });
});

test('ledger migration refuses preexisting unbacked balances without deleting or repairing them', async () => {
  await withFinancialDatabase('Migration20261023000002', async ({ app, orm, owner }) => {
    await insertWallet(app, 'legacy', '100.00');
    await expect(orm.migrator.up()).rejects.toThrow('explicit history migration');
    expect(await walletState(app)).toEqual([{ balance: '100.00', version: '1' }]);
    expect((await owner`SELECT to_regclass('wallet_ledger_entries') AS name`)[0].name).toBeNull();
    expect(await orm.migrator.getExecuted()).toHaveLength(2);
  });
});

test('concurrent stale writers use distinct sessions and cannot commit two ledgers for the same wallet version', async () => {
  await withFinancialDatabase(migration, async ({ app }) => {
    await openFundedWallet(app);
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const sessions = new Set<string>();
    const attempts = ['first', 'second'].map((id) => app.begin(async (sql) => {
      const [row] = await sql`SELECT balance::text, pg_backend_pid()::text AS pid FROM wallets WHERE id='wallet-1'`;
      expect(row.balance).toBe('100.00');
      sessions.add(row.pid);
      if (++arrived === 2) release();
      await barrier;
      await credit(sql, id);
    }));
    const results = await Promise.allSettled(attempts);
    expect(sessions.size).toBe(2);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((result) => result.status === 'rejected');
    expect(failure?.status === 'rejected' && failure.reason.errno).toBe('23505');
    expect(await walletState(app)).toEqual([{ balance: '125.00', version: '2' }]);
    expect((await app`SELECT count(*)::text AS count FROM wallet_ledger_entries`)[0].count).toBe('2');
    expect((await app`SELECT count(*)::text AS count FROM wager_transactions`)[0].count).toBe('2');
  });
}, 15_000);

test('SQL preserves exact cents across a complete credit chain without decimal rounding', async () => {
  await withFinancialDatabase(migration, async ({ app }) => {
    await insertWallet(app);
    for (const movement of [
      { id: 'ten-cents', amount: '0.10', before: '0.00', after: '0.10', version: 2 },
      { id: 'twenty-cents', amount: '0.20', before: '0.10', after: '0.30', version: 3 },
    ]) {
      await app.begin(async (sql) => {
        await insertTransaction(sql, { id: movement.id, amount: movement.amount, kind: 'WIN', status: 'PROCESSED' });
        await insertLedger(sql, { ...movement, transaction: movement.id });
        await sql`UPDATE wallets SET balance=${movement.after},version=${movement.version}`;
      });
    }
    expect(await walletState(app)).toEqual([{ balance: '0.30', version: '3' }]);
  });
});
