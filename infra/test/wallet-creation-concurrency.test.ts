import { expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { MikroORM } from '@mikro-orm/postgresql';
import type { FinancialUnitOfWork } from '../../src/application/ports/financial-persistence.js';
import { createOrmOptions } from '../../src/infrastructure/persistence/orm-options.js';
import { MikroFinancialUnitOfWork } from '../../src/infrastructure/persistence/financial/financial-unit-of-work.js';
import { withMessagingDatabase } from './messaging-support.js';
import { creator, expectCounts, fundedInput } from './wallet-creation-support.js';

function gate() {
  let open!: () => void;
  const ready = new Promise<void>(resolve => { open = resolve; });
  return { ready, open };
}
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Wallet creation concurrency timed out')), 5000);
    })]);
  } finally { clearTimeout(timer); }
}
async function observeWalletWait(sql: SQL): Promise<void> {
  const deadline = Date.now() + 4000;
  do {
    const rows = await sql`SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'
        AND query LIKE '%INSERT INTO wallets%' AND cardinality(pg_blocking_pids(pid))>0`;
    if (rows[0]) { expect(rows[0].blockers[0]).not.toBe(rows[0].pid); return; }
    await Bun.sleep(10); // Sampling cadence only; the server proves two independent sessions and a lock wait.
  } while (Date.now() < deadline);
  throw new Error('No concurrent wallet INSERT lock wait observed');
}

test.each(['commit', 'rollback'] as const)('concurrent CreateWallet waits for %s while another wallet advances', async ending => {
  await withMessagingDatabase(async ({ unit, app, applicationUrl }) => {
    const secondOrm = await MikroORM.init(createOrmOptions(applicationUrl));
    const secondUnit = new MikroFinancialUnitOfWork(secondOrm);
    const held = gate(), release = gate();
    let returned = false;
    const paused: FinancialUnitOfWork = { run: work => unit.run(async repos => {
      const result = await work(repos);
      held.open();
      await release.ready;
      if (ending === 'rollback') throw new Error('abort first opening');
      return result;
    }) };
    const first = creator(paused, 'first').execute(fundedInput)
      .then(value => { returned = true; return value; }, (error: unknown) => error);
    let second: Promise<unknown> | undefined, other: Promise<unknown> | undefined;
    try {
      await bounded(held.ready);
      expect(returned).toBe(false);
      await expectCounts(app, '0', '0', '0', '0'); // No uncommitted rows, including events, visible to observers.
      second = creator(secondUnit, 'second').execute(fundedInput).then(value => value, (error: unknown) => error);
      await observeWalletWait(app);
      other = creator(secondUnit, 'other').execute({ ...fundedInput, playerId: 'other-player' })
        .then(value => value, (error: unknown) => error);
      expect(await bounded(other)).toMatchObject({ id: 'other-1', version: 1 });
      release.open();
      const firstResult = await bounded(first), secondResult = await bounded(second);
      if (ending === 'commit') {
        expect(firstResult).toMatchObject({ id: 'first-1', version: 1 });
        expect(secondResult).toHaveProperty('code', 'WALLET_ALREADY_EXISTS');
      } else {
        expect(firstResult).toHaveProperty('message', 'abort first opening');
        expect(secondResult).toMatchObject({ id: 'second-1', version: 1 });
      }
      await expectCounts(app, '2', '2', '2', '4');
      expect((await app`SELECT count(*)::text AS n FROM wallets WHERE player_id='player' AND currency='BRL'`)[0].n).toBe('1');
      expect((await app`SELECT count(*)::text AS n FROM outbox_messages WHERE payload->'data'->>'walletId' IN ('first-1','second-1')`)[0].n).toBe('2');
    } finally {
      release.open();
      await Promise.allSettled([first, second, other].filter(value => value !== undefined));
      await secondOrm.close();
    }
  });
}, 30_000);
