import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { MikroORM } from '@mikro-orm/postgresql';
import type { FinancialUnitOfWork } from '../../src/application/ports/financial-persistence.js';
import type { WagerResult } from '../../src/application/wagering/wager-result.js';
import { createOrmOptions } from '../../src/infrastructure/persistence/orm-options.js';
import { MikroFinancialUnitOfWork } from '../../src/infrastructure/persistence/financial/financial-unit-of-work.js';
import { withBetDatabase, gate, bounded, observeWait, assertReconciled } from './bet-support.js';
import { creator, fundedInput } from './wallet-creation-support.js';
import { betInput, processor } from './bet-processing-support.js';

test('two BETs of 80 against 100 serialize by wallet while an independent wallet progresses', async () => {
  await withBetDatabase(async ({ unit, app, applicationUrl }) => {
    const wallet = await creator(unit).execute(fundedInput);
    const otherWallet = await creator(unit, 'other-wallet').execute({ ...fundedInput, playerId: 'other-player' });
    const orm = await MikroORM.init(createOrmOptions(applicationUrl));
    const secondUnit = new MikroFinancialUnitOfWork(orm);
    const held = gate(), release = gate();
    const paused: FinancialUnitOfWork = { run: work => unit.run(async repos => {
      const result = await work(repos); held.open(); await release.ready; return result;
    }) };
    const input = betInput(wallet.id, { money: { amount: '80.00', currency: 'BRL' } });
    const first = processor(paused, 'first').execute(input).then(value => value, (error: unknown) => error);
    let second: Promise<unknown> | undefined;
    try {
      await bounded(held.ready);
      second = processor(secondUnit, 'second').execute({ ...input, externalTransactionId: 'second', idempotencyKey: 'second' })
        .then(value => value, (error: unknown) => error);
      await observeWait(app, 'FOR NO KEY UPDATE');
      expect(await bounded(processor(secondUnit, 'independent').execute(betInput(otherWallet.id,
        { playerId: 'other-player', externalTransactionId: 'independent', idempotencyKey: 'independent' }))))
        .toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00' } });
      release.open();
      expect(await bounded(first)).toMatchObject({ status: 'PROCESSED', balance: { amount: '20.00' } });
      expect(await bounded(second)).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '20.00' } });
      expect((await app`SELECT balance::text,version::text FROM wallets WHERE id=${wallet.id}`)[0]).toEqual({ balance: '20.00', version: '2' });
      expect((await app`SELECT count(*)::text AS n FROM wallet_ledger_entries WHERE wallet_id=${wallet.id} AND direction='DEBIT'`)[0].n).toBe('1');
      expect((await app`SELECT count(*)::text AS n FROM outbox_messages WHERE payload->'data'->>'walletId'=${wallet.id}`)[0].n).toBe('5'); // 2 opening + 2 processed + 1 rejected.
      await assertReconciled(app);
    } finally { release.open(); await Promise.allSettled([first, second]); await orm.close(); }
  });
}, 30_000);

test.each(['replay', 'payload-conflict', 'external-conflict'] as const)('concurrent same identity produces %s after waiting for commit', async scenario => {
  await withBetDatabase(async ({ unit, app, applicationUrl }) => {
    const wallet = await creator(unit).execute(fundedInput);
    const orm = await MikroORM.init(createOrmOptions(applicationUrl));
    const held = gate(), release = gate();
    const paused: FinancialUnitOfWork = { run: work => unit.run(async repos => {
      const result = await work(repos); held.open(); await release.ready; return result;
    }) };
    const input = betInput(wallet.id);
    const first = processor(paused).execute(input).then(value => value, (error: unknown) => error);
    let second: Promise<unknown> | undefined;
    try {
      await bounded(held.ready);
      const patch = scenario === 'payload-conflict' ? { money: { amount: '26.00', currency: 'BRL' } }
        : scenario === 'external-conflict' ? { idempotencyKey: 'another-key' } : {};
      second = processor(new MikroFinancialUnitOfWork(orm), 'duplicate').execute({ ...input, ...patch })
        .then(value => value, (error: unknown) => error);
      await observeWait(app, 'pg_advisory_xact_lock'); release.open();
      expect(await bounded(first)).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });
      const result = await bounded(second);
      if (scenario === 'replay') expect(result).toMatchObject({ transactionId: 'bet-1', balance: { amount: '75.00' }, idempotentReplay: true });
      else expect(result).toHaveProperty('code', scenario === 'payload-conflict' ? 'IDEMPOTENCY_CONFLICT' : 'EXTERNAL_TRANSACTION_CONFLICT');
      expect((await app`SELECT count(*)::text AS n FROM wager_transactions WHERE kind='BET'`)[0].n).toBe('1');
      expect((await app`SELECT count(*)::text AS n FROM outbox_messages`)[0].n).toBe('4');
      await assertReconciled(app);
    } finally { release.open(); await Promise.allSettled([first, second]); await orm.close(); }
  });
}, 30_000);

test('50 parallel copies across three real Bun processes produce one debit and 49 historical replays', async () => {
  await withBetDatabase(async ({ unit, app, applicationUrl }) => {
    const wallet = await creator(unit).execute(fundedInput), held = gate(), release = gate();
    const blocker = unit.run(async repos => { await repos.wallets.findByIdForUpdate(wallet.id); held.open(); await release.ready; });
    await bounded(held.ready);
    const children = [17, 17, 16].map((count, index) => {
      const url = new URL(applicationUrl); url.searchParams.set('application_name', `bet-worker-${index}`);
      return Bun.spawn([process.execPath, fileURLToPath(new URL('./bet-worker.ts', import.meta.url))], {
        env: { ...process.env, DWP_BET_DB: url.href, DWP_BET_COUNT: String(count), DWP_BET_INPUT: JSON.stringify(betInput(wallet.id)) },
        stdout: 'pipe', stderr: 'pipe',
      });
    });
    try {
      const deadline = Date.now() + 6000;
      let workers = 0;
      do {
        const rows = await app`SELECT DISTINCT application_name FROM pg_stat_activity WHERE datname=current_database()
          AND application_name LIKE 'bet-worker-%' AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0`;
        workers = rows.length;
        if (workers === 3) break;
        await Bun.sleep(10);
      } while (Date.now() < deadline);
      expect(workers).toBe(3); // All three processes reached PostgreSQL concurrently before the barrier opens.
      release.open(); await bounded(blocker);
      const reports = await bounded(Promise.all(children.map(async child => {
        const [output, error, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect(error).toBe(''); expect(exitCode).toBe(0);
        return JSON.parse(output) as { pid: number; results: WagerResult[] };
      })));
      expect(new Set(reports.map(report => report.pid)).size).toBe(3);
      const results = reports.flatMap(report => report.results);
      expect(results).toHaveLength(50);
      expect(results.filter(result => !result.idempotentReplay)).toHaveLength(1);
      expect(results.filter(result => result.idempotentReplay)).toHaveLength(49);
      expect(new Set(results.map(result => result.transactionId)).size).toBe(1);
      for (const result of results) expect(result).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00', currency: 'BRL' } });
      expect((await app`SELECT count(*)::text AS n FROM wager_transactions WHERE kind='BET'`)[0].n).toBe('1');
      expect((await app`SELECT count(*)::text AS n FROM wallet_ledger_entries WHERE direction='DEBIT'`)[0].n).toBe('1');
      expect((await app`SELECT count(*)::text AS n FROM wager_transaction_results`)[0].n).toBe('1');
      expect((await app`SELECT count(*)::text AS n FROM outbox_messages`)[0].n).toBe('4');
      await assertReconciled(app);
    } finally {
      release.open(); await blocker;
      for (const child of children) if (child.exitCode === null) child.kill();
      await Promise.allSettled(children.map(child => child.exited));
    }
  });
}, 30_000);
