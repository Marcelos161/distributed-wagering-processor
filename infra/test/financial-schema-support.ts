import { expect } from 'bun:test';
import { SQL } from 'bun';
import { MikroORM } from '@mikro-orm/postgresql';
import { createMigrationOptions } from '../../scripts/migration-options.js';
import { withDisposableDatabase } from './disposable-database.js';

export interface FinancialDatabase {
  app: SQL;
  owner: SQL;
  orm: MikroORM;
  applicationUrl: string;
}

/** Applies only repository migrations, always in an isolated database. */
export async function withFinancialDatabase(
  to: string,
  run: (database: FinancialDatabase) => Promise<void>,
): Promise<void> {
  await withDisposableDatabase(async (urls) => {
    const orm = await MikroORM.init(createMigrationOptions(urls.migrations));
    const app = new SQL(urls.application);
    const owner = new SQL(urls.migrations);
    try {
      await orm.migrator.up({ to });
      await run({ app, owner, orm, applicationUrl: urls.application });
    } finally {
      await Promise.all([app.close(), owner.close(), orm.close()]);
    }
  });
}

export async function expectSqlState(run: () => Promise<unknown>, sqlstate: string): Promise<void> {
  let caught: unknown;
  try { await run(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect(caught).toHaveProperty('errno', sqlstate);
}

export async function insertWallet(sql: SQL, id = 'wallet-1', balance = '0.00'): Promise<void> {
  await sql`INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
    VALUES (${id}, ${'player-' + id}, 'BRL', ${balance}, 1, '2026-10-23T12:00:00Z', '2026-10-23T12:00:00Z')`;
}
