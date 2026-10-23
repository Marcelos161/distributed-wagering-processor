import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { MikroORM } from '@mikro-orm/postgresql';
import type { FinancialUnitOfWork } from '../../src/application/ports/financial-persistence.js';
import type { WagerResult } from '../../src/application/wagering/wager-result.js';
import { createOrmOptions } from '../../src/infrastructure/persistence/orm-options.js';
import { MikroFinancialUnitOfWork } from '../../src/infrastructure/persistence/financial/financial-unit-of-work.js';
import { withRefundDatabase, refundInput } from './refund-support.js';
import { gate, bounded, observeWait, assertReconciled } from './bet-support.js';
import { creator, fundedInput } from './wallet-creation-support.js';
import { betInput, processor } from './bet-processing-support.js';
import { wagerInput } from './wager-support.js';
import { insertTransaction } from './financial-schema-support.js';

test.each(['commit', 'rollback'] as const)('two distinct REFUNDs serialize by wallet after first %s; independent wallet progresses', async outcome => {
  await withRefundDatabase(async ({ unit, app, applicationUrl }) => {
    const wallet = await creator(unit).execute(fundedInput); await processor(unit, 'setup').execute(betInput(wallet.id));
    const other = await creator(unit, 'other-wallet').execute({ ...fundedInput, playerId: 'other' });
    const orm = await MikroORM.init(createOrmOptions(applicationUrl)), secondUnit = new MikroFinancialUnitOfWork(orm);
    const held = gate(), release = gate();
    const paused: FinancialUnitOfWork = { run: work => unit.run(async repos => {
      const result = await work(repos); held.open(); await release.ready;
      if (outcome === 'rollback') throw new Error('first refund aborted'); return result;
    }) };
    const first = processor(paused, 'first').execute(refundInput(wallet.id)).catch((error: unknown) => error);
    let second: Promise<unknown> | undefined;
    try {
      await bounded(held.ready);
      second = processor(secondUnit, 'second').execute(refundInput(wallet.id, { externalTransactionId: 'second', idempotencyKey: 'second' })).catch((error: unknown) => error);
      await observeWait(app, 'FOR NO KEY UPDATE');
      expect(await bounded(processor(secondUnit, 'independent').execute(wagerInput(other.id, 'WIN',
        { playerId: 'other', externalTransactionId: 'independent', idempotencyKey: 'independent' }))))
        .toMatchObject({ status: 'PROCESSED', balance: { amount: '140.50' } });
      release.open(); const result1 = await bounded(first), result2 = await bounded(second);
      if (outcome === 'commit') {
        expect(result1).toMatchObject({ status: 'PROCESSED' });
        expect(result2).toMatchObject({ status: 'REJECTED', failureCode: 'DUPLICATE_REVERSAL', balance: { amount: '100.00' } });
      } else {
        expect(result1).toBeInstanceOf(Error); expect(result2).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' } });
      }
      expect((await app`SELECT balance::text,version::text FROM wallets WHERE id=${wallet.id}`)[0]).toEqual({ balance: '100.00', version: '3' });
      expect((await app`SELECT count(*)::text n FROM wager_transactions WHERE kind='REFUND' AND status='PROCESSED'`)[0].n).toBe('1');
      expect((await app`SELECT count(*)::text n FROM wallet_ledger_entries WHERE wallet_id=${wallet.id} AND wallet_version=3`)[0].n).toBe('1');
      expect((await app`SELECT count(*)::text n FROM wager_transactions WHERE kind='REFUND' AND status='REJECTED'`)[0].n).toBe(outcome === 'commit' ? '1' : '0');
      expect((await app`SELECT count(*)::text n FROM outbox_messages WHERE payload->'data'->>'walletId'=${wallet.id}`)[0].n).toBe(outcome === 'commit' ? '7' : '6');
      await assertReconciled(app);
    } finally { release.open(); await Promise.allSettled([first, second]); await orm.close(); }
  });
}, 30000);

test.each(['WIN', 'BET'] as const)('REFUND and concurrent %s see the serialized wallet state', async kind => {
  await withRefundDatabase(async ({ unit, app, applicationUrl }) => {
    const wallet = await creator(unit).execute(fundedInput); await processor(unit, 'setup').execute(betInput(wallet.id));
    const held = gate(), release = gate(), orm = await MikroORM.init(createOrmOptions(applicationUrl));
    const paused: FinancialUnitOfWork = { run: work => unit.run(async repos => {
      const result = await work(repos); held.open(); await release.ready; return result;
    }) };
    const first = processor(paused, 'first').execute(refundInput(wallet.id));
    let second: Promise<WagerResult> | undefined;
    try {
      await bounded(held.ready);
      second = processor(new MikroFinancialUnitOfWork(orm), 'second').execute({ ...(kind === 'WIN' ? wagerInput(wallet.id) : betInput(wallet.id)),
        externalTransactionId: 'other', idempotencyKey: 'other' });
      await observeWait(app, 'FOR NO KEY UPDATE'); release.open(); await bounded(first);
      expect(await bounded(second)).toMatchObject({ status: 'PROCESSED', balance: { amount: kind === 'WIN' ? '140.50' : '75.00' } });
      expect((await app`SELECT version::text FROM wallets`)[0].version).toBe('4'); await assertReconciled(app);
    } finally { release.open(); await Promise.allSettled([first, second]); await orm.close(); }
  });
}, 30000);

test.each(['commit', 'rollback'] as const)('REFUND racing BET arrival observes its %s after wallet lock', async outcome => {
  await withRefundDatabase(async ({ unit, app, applicationUrl }) => {
    const wallet = await creator(unit).execute(fundedInput), held = gate(), release = gate();
    const orm = await MikroORM.init(createOrmOptions(applicationUrl));
    const paused: FinancialUnitOfWork = { run: work => unit.run(async repos => {
      const result = await work(repos); held.open(); await release.ready;
      if (outcome === 'rollback') throw new Error('bet aborted'); return result;
    }) };
    const first = processor(paused, 'bet').execute(betInput(wallet.id)).catch((error: unknown) => error);
    let second: Promise<WagerResult> | undefined;
    try {
      await bounded(held.ready);
      second = processor(new MikroFinancialUnitOfWork(orm), 'refund').execute(refundInput(wallet.id));
      await observeWait(app, 'FOR NO KEY UPDATE'); release.open(); await bounded(first);
      const result = await bounded(second);
      expect(result).toMatchObject({ status: outcome === 'commit' ? 'PROCESSED' : 'PENDING_REFERENCE', balance: { amount: '100.00' } });
      expect((await app`SELECT version::text FROM wallets`)[0].version).toBe(outcome === 'commit' ? '3' : '1');
      await assertReconciled(app);
    } finally { release.open(); await Promise.allSettled([first, second]); await orm.close(); }
  });
}, 30000);

test('REFUND does not acquire a circular reference lock while another session is inserting a PENDING BET', async () => {
  await withRefundDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute(fundedInput), held = gate(), release = gate();
    const pendingBet = app.begin(async connection => {
      await insertTransaction(connection, { id: 'pending', external: 'external-1', wallet: wallet.id, player: 'player', round: 'round' });
      held.open(); await release.ready;
    });
    try {
      await bounded(held.ready);
      const useCase = processor(unit), input = refundInput(wallet.id);
      const result = await bounded(useCase.execute(input));
      expect(result).toMatchObject({ status: 'PENDING_REFERENCE', balance: { amount: '100.00' } });
      release.open(); await pendingBet;
      expect(await useCase.execute(input)).toEqual({ ...result, idempotentReplay: true });
      expect((await app`SELECT count(*)::text n FROM wallet_ledger_entries`)[0].n).toBe('1'); await assertReconciled(app);
    } finally { release.open(); await pendingBet; }
  });
}, 30000);

test('unique reversal index blocks concurrent direct SQL bypass until the first refund commits', async () => {
  await withRefundDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute(fundedInput), bet = await processor(unit, 'setup').execute(betInput(wallet.id));
    const held = gate(), release = gate();
    const paused: FinancialUnitOfWork = { run: work => unit.run(async repos => {
      const result = await work(repos); held.open(); await release.ready; return result;
    }) };
    const first = processor(paused, 'first').execute(refundInput(wallet.id));
    let bypass: Promise<unknown> | undefined;
    try {
      await bounded(held.ready);
      bypass = app.begin(connection => insertTransaction(connection, { id: 'bypass', external: 'bypass', key: 'bypass',
        wallet: wallet.id, player: 'player', round: 'round', kind: 'REFUND', status: 'PROCESSED',
        reference: bet.transactionId, externalReference: 'external-1' })).catch((error: unknown) => error);
      await observeWait(app, 'INSERT INTO wager_transactions'); release.open(); await bounded(first);
      expect(await bounded(bypass)).toMatchObject({ errno: '23505', constraint: 'wager_successful_reversal_unique' });
      expect((await app`SELECT count(*)::text n FROM wager_transactions WHERE kind='REFUND'`)[0].n).toBe('1');
      expect((await app`SELECT balance::text,version::text FROM wallets`)[0]).toEqual({ balance: '100.00', version: '3' });
      await assertReconciled(app);
    } finally { release.open(); await Promise.allSettled([first, bypass]); }
  });
}, 30000);

test('50 identical REFUNDs in three Bun processes produce one reimbursement and 49 historical replays', async () => {
  await withRefundDatabase(async ({ unit, app, applicationUrl }) => {
    const wallet = await creator(unit).execute(fundedInput); await processor(unit, 'setup').execute(betInput(wallet.id));
    const held = gate(), release = gate();
    const blocker = unit.run(async repos => { await repos.wallets.findByIdForUpdate(wallet.id); held.open(); await release.ready; });
    await bounded(held.ready);
    const children = [17, 17, 16].map((count, index) => {
      const url = new URL(applicationUrl); url.searchParams.set('application_name', `refund-worker-${index}`);
      return Bun.spawn([process.execPath, fileURLToPath(new URL('./bet-worker.ts', import.meta.url))], {
        env: { ...process.env, DWP_BET_DB: url.href, DWP_BET_COUNT: String(count), DWP_BET_INPUT: JSON.stringify(refundInput(wallet.id)) },
        stdout: 'pipe', stderr: 'pipe',
      });
    });
    try {
      const deadline = Date.now() + 6000; let workers = 0;
      do {
        workers = (await app`SELECT DISTINCT application_name FROM pg_stat_activity WHERE datname=current_database()
          AND application_name LIKE 'refund-worker-%' AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0`).length;
        if (workers === 3) break; await Bun.sleep(10);
      } while (Date.now() < deadline);
      expect(workers).toBe(3); release.open(); await bounded(blocker);
      const reports = await bounded(Promise.all(children.map(async child => {
        const [output, error, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect(error).toBe(''); expect(exitCode).toBe(0);
        return JSON.parse(output) as { pid: number; results: WagerResult[] };
      })));
      expect(new Set(reports.map(r => r.pid)).size).toBe(3);
      const results = reports.flatMap(r => r.results); expect(results).toHaveLength(50);
      expect(results.filter(r => !r.idempotentReplay)).toHaveLength(1); expect(results.filter(r => r.idempotentReplay)).toHaveLength(49);
      expect(new Set(results.map(r => r.transactionId)).size).toBe(1);
      for (const result of results) expect(result).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' } });
      const id = results[0]!.transactionId;
      expect((await app`SELECT balance::text,version::text FROM wallets`)[0]).toEqual({ balance: '100.00', version: '3' });
      expect((await app`SELECT count(*)::text n FROM wager_transactions WHERE kind='REFUND'`)[0].n).toBe('1');
      expect((await app`SELECT count(*)::text n FROM wallet_ledger_entries WHERE transaction_id=${id}`)[0].n).toBe('1');
      expect((await app`SELECT count(*)::text n FROM wager_transaction_results WHERE transaction_id=${id}`)[0].n).toBe('1');
      expect((await app`SELECT count(*)::text n FROM outbox_messages WHERE payload->'data'->>'transactionId'=${id}`)[0].n).toBe('2');
      await assertReconciled(app);
    } finally {
      release.open(); await blocker;
      for (const child of children) if (child.exitCode === null) child.kill();
      await Promise.allSettled(children.map(child => child.exited));
    }
  });
}, 30000);
