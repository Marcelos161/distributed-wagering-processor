import { expect } from 'bun:test';
import type { SQL } from 'bun';
import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmOptions } from '../../src/infrastructure/persistence/orm-options.js';
import { MikroFinancialUnitOfWork } from '../../src/infrastructure/persistence/financial/financial-unit-of-work.js';
import { withFinancialDatabase, type FinancialDatabase } from './financial-schema-support.js';

export interface BetDatabase extends FinancialDatabase { appOrm: MikroORM; unit: MikroFinancialUnitOfWork; }
export async function withBetDatabase(run: (db: BetDatabase) => Promise<void>): Promise<void> {
  await withFinancialDatabase('Migration20261023000005', async db => {
    const appOrm = await MikroORM.init(createOrmOptions(db.applicationUrl));
    try { await run({ ...db, appOrm, unit: new MikroFinancialUnitOfWork(appOrm) }); }
    finally { await appOrm.close(); }
  });
}
export async function assertReconciled(sql: SQL): Promise<void> {
  const rows = await sql`SELECT w.id FROM wallets w LEFT JOIN wallet_ledger_entries e ON e.wallet_id=w.id
    GROUP BY w.id HAVING w.balance <> COALESCE(sum(CASE WHEN e.direction='CREDIT' THEN e.amount ELSE -e.amount END),0)`;
  expect(rows).toEqual([]);
}
export function gate() {
  let open!: () => void;
  const ready = new Promise<void>(resolve => { open = resolve; });
  return { ready, open };
}
export async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('BET concurrent operation timed out')), 8000);
  })]); } finally { clearTimeout(timer); }
}
export async function observeWait(sql: SQL, query: string): Promise<void> {
  const deadline = Date.now() + 6000;
  do {
    const rows = await sql`SELECT pid,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE ${'%' + query + '%'}
      AND cardinality(pg_blocking_pids(pid))>0`;
    if (rows[0]) { expect(rows[0].blockers[0]).not.toBe(rows[0].pid); return; }
    await Bun.sleep(10);
  } while (Date.now() < deadline);
  throw new Error('Expected PostgreSQL wait was not observed');
}

/** Consume stdout until a real child milestone, tolerating preceding structured logs. */
export async function readUntil(stream: ReadableStream<Uint8Array>, marker: string): Promise<string> {
  const reader = stream.getReader(); let text = '';
  try {
    while (!text.includes(marker)) {
      const chunk = await bounded(reader.read());
      if (chunk.done) throw new Error('Child exited before milestone');
      text += new TextDecoder().decode(chunk.value);
    }
    return text;
  } finally { reader.releaseLock(); }
}
