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

export interface TransactionFixture {
  id: string;
  provider: string;
  external: string;
  key: string;
  hash: string;
  wallet: string;
  player: string;
  round: string;
  game: string;
  kind: string;
  amount: string;
  currency: string;
  status: string;
  externalReference: string | null;
  reference: string | null;
  failure: string | null;
  processedAt: string | null;
}

export async function insertTransaction(sql: SQL, patch: Partial<TransactionFixture> = {}): Promise<void> {
  const id = patch.id ?? 'bet-1';
  const row: TransactionFixture = {
    id, provider: 'provider-a', external: id, key: id, hash: 'opaque-hash', wallet: 'wallet-1',
    player: 'player-wallet-1', round: 'round-1', game: 'game-1', kind: 'BET', amount: '25.00',
    currency: 'BRL', status: 'PENDING', externalReference: null, reference: null, failure: null,
    processedAt: patch.status === 'PROCESSED' ? '2026-10-23T12:01:00Z' : null, ...patch,
  };
  await sql`INSERT INTO wager_transactions (id,provider_id,external_transaction_id,idempotency_key,payload_hash,
    wallet_id,player_id,round_id,game_id,kind,amount,currency,status,reference_external_transaction_id,
    reference_transaction_id,failure_code,created_at,processed_at)
    VALUES (${row.id},${row.provider},${row.external},${row.key},${row.hash},${row.wallet},${row.player},
    ${row.round},${row.game},${row.kind},${row.amount},${row.currency},${row.status},${row.externalReference},
    ${row.reference},${row.failure},'2026-10-23T12:00:00Z',${row.processedAt})`;
}
