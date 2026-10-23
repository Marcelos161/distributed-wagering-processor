import { expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../../src/domain/money/money.js';
import { createOrmOptions } from '../../src/infrastructure/persistence/orm-options.js';
import { expectSqlState, insertWallet, withFinancialDatabase } from './financial-schema-support.js';

const migration = 'Migration20261023000001';

test('wallet schema enforces primary key, player/currency uniqueness and required fields', async () => {
  await withFinancialDatabase(migration, async ({ app }) => {
    await insertWallet(app);
    await expectSqlState(() => insertWallet(app), '23505');
    await expectSqlState(() => app`INSERT INTO wallets SELECT 'other', player_id, currency, balance, version, created_at, updated_at FROM wallets`, '23505');
    await app`INSERT INTO wallets SELECT 'usd-wallet', player_id, 'USD', balance, version, created_at, updated_at FROM wallets`;
    expect((await app`SELECT count(*)::text AS count FROM wallets`)[0].count).toBe('2');
    await expectSqlState(() => app`INSERT INTO wallets (id) VALUES ('missing')`, '23502');
  });
});

test('wallet rejects negative, overflow, excess scale and nonfinite money through direct SQL', async () => {
  await withFinancialDatabase(migration, async ({ app }) => {
    for (const invalid of ['-0.01', '1000000000000000000.00', '1.005', '1.000', 'NaN', 'Infinity', '-Infinity']) {
      await expectSqlState(() => insertWallet(app, 'invalid', invalid), '23514');
    }
    expect((await app`SELECT count(*)::text AS count FROM wallets`)[0].count).toBe('0');
    await insertWallet(app, 'maximum', '999999999999999999.99');
    expect((await app`SELECT balance::text AS balance FROM wallets`)[0].balance).toBe('999999999999999999.99');
  });
});

test('wallet validates currency, identifiers, version bounds and finite timestamps', async () => {
  await withFinancialDatabase(migration, async ({ app, owner }) => {
    await insertWallet(app);
    for (const version of ['0', '-1', '9007199254740992']) {
      await expectSqlState(() => app`UPDATE wallets SET version=${version}`, '23514');
    }
    for (const currency of ['brl', 'JPY', '']) {
      await expectSqlState(() => owner`UPDATE wallets SET currency=${currency}`, '23514');
    }
    for (const id of ['', 'two words', 'ending\n']) {
      await expectSqlState(() => insertWallet(app, id), '23514');
    }
    await expectSqlState(() => app`UPDATE wallets SET updated_at='infinity'`, '23514');
    await expectSqlState(() => app`UPDATE wallets SET balance=NULL`, '23502');
    await app`UPDATE wallets SET version=9007199254740991`;
  });
});

test('wallet grants permit only application data operations and prevent DDL, identity updates and deletion', async () => {
  await withFinancialDatabase(migration, async ({ app }) => {
    await insertWallet(app);
    await app`UPDATE wallets SET balance='0.01', version=2, updated_at=now()`;
    for (const sql of ['UPDATE wallets SET player_id=\'changed\'', 'DELETE FROM wallets', 'TRUNCATE wallets',
      'DROP TABLE wallets', 'ALTER TABLE wallets DISABLE TRIGGER ALL', 'CREATE TABLE forbidden (id text)']) {
      await expectSqlState(() => app.unsafe(sql), '42501');
    }
  });
});

test('MikroORM and PostgreSQL return exact financial decimals as strings compatible with Money', async () => {
  await withFinancialDatabase(migration, async ({ app, applicationUrl }) => {
    const original = Money.from({ amount: '999999999999999999.99', currency: 'BRL' });
    await insertWallet(app, 'exact', original.toJSON().amount);
    const orm = await MikroORM.init(createOrmOptions(applicationUrl));
    try {
      const rows = await orm.em.fork().execute<Array<{ balance: string; currency: string }>>('SELECT balance, currency FROM wallets');
      expect(typeof rows[0]!.balance).toBe('string');
      expect(Money.from({ amount: rows[0]!.balance, currency: rows[0]!.currency }).equals(original)).toBe(true);
    } finally { await orm.close(); }
  });
});

test('wallet migration applies once, reverses in a disposable database and reapplies cleanly', async () => {
  await withFinancialDatabase(migration, async ({ owner, orm }) => {
    expect((await owner`SELECT to_regclass('public.wallets')::text AS name`)[0].name).toBe('wallets');
    expect(await orm.migrator.up({ to: migration })).toHaveLength(0);
    await orm.migrator.down({ to: 0 });
    expect((await owner`SELECT to_regclass('public.wallets') AS name`)[0].name).toBeNull();
    expect((await owner`SELECT count(*)::text AS count FROM pg_type WHERE typname='financial_amount'`)[0].count).toBe('0');
    await orm.migrator.up({ to: migration });
    expect(await orm.migrator.getExecuted()).toHaveLength(1);
  });
});
