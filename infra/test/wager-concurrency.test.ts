import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { MikroORM } from '@mikro-orm/postgresql';
import type { FinancialUnitOfWork } from '../../src/application/ports/financial-persistence.js';
import type { WagerResult } from '../../src/application/wagering/wager-result.js';
import { createOrmOptions } from '../../src/infrastructure/persistence/orm-options.js';
import { MikroFinancialUnitOfWork } from '../../src/infrastructure/persistence/financial/financial-unit-of-work.js';
import { withWagerDatabase, wagerInput } from './wager-support.js';
import { gate, bounded, observeWait, assertReconciled } from './bet-support.js';
import { creator, fundedInput } from './wallet-creation-support.js';
import { betInput, processor } from './bet-processing-support.js';

const pairs = [
  ['WIN', 'WIN', '181.00', '3'], ['BET', 'WIN', '115.50', '3'], ['WIN', 'BET', '115.50', '3'],
  ['WIN', 'LOSS', '140.50', '2'], ['LOSS', 'WIN', '140.50', '2'],
] as const;
test.each(pairs)('%s then concurrent %s serializes without stale balance while another wallet progresses', async (firstKind, secondKind, balance, version) => {
  await withWagerDatabase(async ({ unit, app, applicationUrl }) => {
    const wallet = await creator(unit).execute(fundedInput);
    const other = await creator(unit, 'other-wallet').execute({ ...fundedInput, playerId: 'other' });
    const orm = await MikroORM.init(createOrmOptions(applicationUrl)), secondUnit = new MikroFinancialUnitOfWork(orm);
    const held = gate(), release = gate();
    const paused: FinancialUnitOfWork = { run: work => unit.run(async repos => {
      const result = await work(repos); held.open(); await release.ready; return result;
    }) };
    const firstInput = firstKind === 'BET' ? betInput(wallet.id) : wagerInput(wallet.id, firstKind);
    const secondInput = secondKind === 'BET' ? betInput(wallet.id) : wagerInput(wallet.id, secondKind);
    const first = processor(paused, 'first').execute(firstInput).catch((error: unknown) => error);
    let second: Promise<unknown> | undefined;
    try {
      await bounded(held.ready);
      second = processor(secondUnit, 'second').execute({ ...secondInput, externalTransactionId: 'second', idempotencyKey: 'second' }).catch((error: unknown) => error);
      await observeWait(app, 'FOR NO KEY UPDATE');
      expect(await bounded(processor(secondUnit, 'independent').execute(wagerInput(other.id, 'WIN',
        { playerId: 'other', externalTransactionId: 'other', idempotencyKey: 'other' }))))
        .toMatchObject({ status: 'PROCESSED', balance: { amount: '140.50' } });
      release.open(); expect(await bounded(first)).toMatchObject({ status: 'PROCESSED' });
      expect(await bounded(second)).toMatchObject({ status: 'PROCESSED', balance: { amount: balance } });
      expect((await app`SELECT balance::text,version::text FROM wallets WHERE id=${wallet.id}`)[0]).toEqual({ balance, version });
      await assertReconciled(app);
    } finally { release.open(); await Promise.allSettled([first, second]); await orm.close(); }
  });
}, 30000);

test.each(['LOSS', 'PENDING'] as const)('20 concurrent %s copies store one transaction one event and one snapshot', async scenario => {
  await withWagerDatabase(async ({ unit, app, applicationUrl }) => {
    const wallet = await creator(unit).execute(fundedInput), held = gate(), release = gate();
    const orm = await MikroORM.init(createOrmOptions(applicationUrl));
    const paused: FinancialUnitOfWork = { run: work => unit.run(async repos => {
      const result = await work(repos); held.open(); await release.ready; return result;
    }) };
    const input = wagerInput(wallet.id, scenario === 'LOSS' ? 'LOSS' : 'WIN', scenario === 'PENDING' ? { referenceExternalTransactionId: 'absent' } : {});
    const first = processor(paused).execute(input);
    let duplicates: Promise<WagerResult[]> | undefined;
    try {
      await bounded(held.ready);
      const useCase = processor(new MikroFinancialUnitOfWork(orm), 'duplicate');
      duplicates = Promise.all(Array.from({ length: 19 }, () => useCase.execute(input)));
      await observeWait(app, 'pg_advisory_xact_lock'); release.open();
      const original = await bounded(first), results = await bounded(duplicates);
      expect(results).toHaveLength(19);
      for (const result of results) expect(result).toEqual({ ...original, idempotentReplay: true });
      expect((await app`SELECT count(*)::text n FROM wager_transactions WHERE kind <> 'OPENING'`)[0].n).toBe('1');
      expect((await app`SELECT count(*)::text n FROM outbox_messages WHERE aggregate_id=${original.transactionId}`)[0].n).toBe('1');
      expect((await app`SELECT count(*)::text n FROM wager_transaction_results`)[0].n).toBe(scenario === 'LOSS' ? '1' : '0');
      expect((await app`SELECT count(*)::text n FROM wager_pending_receipts`)[0].n).toBe(scenario === 'PENDING' ? '1' : '0');
      expect((await app`SELECT balance::text,version::text FROM wallets`)[0]).toEqual({ balance: '100.00', version: '1' });
      await assertReconciled(app);
    } finally { release.open(); await Promise.allSettled([first, duplicates]); await orm.close(); }
  });
}, 30000);

test.each(['reference', 'external-conflict'] as const)('WIN concurrent with BET resolves %s after the correct PostgreSQL lock', async scenario => {
  await withWagerDatabase(async ({ unit, app, applicationUrl }) => {
    const wallet = await creator(unit).execute(fundedInput), held = gate(), release = gate();
    const orm = await MikroORM.init(createOrmOptions(applicationUrl));
    const paused: FinancialUnitOfWork = { run: work => unit.run(async repos => {
      const result = await work(repos); held.open(); await release.ready; return result;
    }) };
    const first = processor(paused, 'bet').execute(betInput(wallet.id));
    let second: Promise<unknown> | undefined;
    try {
      await bounded(held.ready);
      second = processor(new MikroFinancialUnitOfWork(orm), 'win').execute(wagerInput(wallet.id, 'WIN', {
        idempotencyKey: 'win', externalTransactionId: scenario === 'reference' ? 'win' : 'external-1',
        ...(scenario === 'reference' ? { referenceExternalTransactionId: 'external-1' } : {}),
      })).catch((error: unknown) => error);
      await observeWait(app, scenario === 'reference' ? 'FOR NO KEY UPDATE' : 'pg_advisory_xact_lock');
      release.open(); await bounded(first);
      expect(await bounded(second)).toMatchObject(scenario === 'reference'
        ? { status: 'PROCESSED', balance: { amount: '115.50' } } : { code: 'EXTERNAL_TRANSACTION_CONFLICT' });
      expect((await app`SELECT balance::text FROM wallets`)[0].balance).toBe(scenario === 'reference' ? '115.50' : '75.00');
      await assertReconciled(app);
    } finally { release.open(); await Promise.allSettled([first, second]); await orm.close(); }
  });
}, 30000);

test('crossed WIN references on two wallets do not add a circular lock dependency', async () => {
  await withWagerDatabase(async ({ unit, app, applicationUrl }) => {
    const firstWallet = await creator(unit).execute(fundedInput);
    const secondWallet = await creator(unit, 'second-wallet').execute({ ...fundedInput, playerId: 'second' });
    const orm = await MikroORM.init(createOrmOptions(applicationUrl)), bothInserted = gate();
    let arrived = 0;
    const pauseAfterInsert = (base: FinancialUnitOfWork): FinancialUnitOfWork => ({ run: work => base.run(repos => work({ ...repos, transactions: {
      findProcessedRefund: id => repos.transactions.findProcessedRefund(id),
      findById: id => repos.transactions.findById(id), findByExternalId: (p, e) => repos.transactions.findByExternalId(p, e),
      findByIdempotencyKey: (p, k) => repos.transactions.findByIdempotencyKey(p, k), updateLifecycle: tx => repos.transactions.updateLifecycle(tx),
      insert: async tx => { await repos.transactions.insert(tx); if (++arrived === 2) bothInserted.open(); await bounded(bothInserted.ready); },
    } })) });
    try {
      const results = await bounded(Promise.all([
        processor(pauseAfterInsert(unit), 'first').execute(wagerInput(firstWallet.id, 'WIN', { externalTransactionId: 'first', idempotencyKey: 'first', referenceExternalTransactionId: 'second' })),
        processor(pauseAfterInsert(new MikroFinancialUnitOfWork(orm)), 'second').execute(wagerInput(secondWallet.id, 'WIN', {
          playerId: 'second', externalTransactionId: 'second', idempotencyKey: 'second', referenceExternalTransactionId: 'first' })),
      ]));
      for (const result of results) expect(['PENDING_REFERENCE', 'REJECTED']).toContain(result.status);
      expect((await app`SELECT count(*)::text n FROM wallet_ledger_entries WHERE wallet_version > 1`)[0].n).toBe('0');
      await assertReconciled(app);
    } finally { bothInserted.open(); await orm.close(); }
  });
}, 30000);

test('50 concurrent WIN copies in three Bun processes produce one credit and 49 persisted replays', async () => {
  await withWagerDatabase(async ({ unit, app, applicationUrl }) => {
    const wallet = await creator(unit).execute(fundedInput), held = gate(), release = gate();
    const blocker = unit.run(async repos => { await repos.wallets.findByIdForUpdate(wallet.id); held.open(); await release.ready; });
    await bounded(held.ready);
    const children = [17, 17, 16].map((count, index) => {
      const url = new URL(applicationUrl); url.searchParams.set('application_name', `win-worker-${index}`);
      return Bun.spawn([process.execPath, fileURLToPath(new URL('./bet-worker.ts', import.meta.url))], {
        env: { ...process.env, DWP_BET_DB: url.href, DWP_BET_COUNT: String(count), DWP_BET_INPUT: JSON.stringify(wagerInput(wallet.id)) },
        stdout: 'pipe', stderr: 'pipe',
      });
    });
    try {
      const deadline = Date.now() + 6000;
      let workers = 0;
      do {
        workers = (await app`SELECT DISTINCT application_name FROM pg_stat_activity WHERE datname=current_database()
          AND application_name LIKE 'win-worker-%' AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0`).length;
        if (workers === 3) break;
        await Bun.sleep(10);
      } while (Date.now() < deadline);
      expect(workers).toBe(3); release.open(); await bounded(blocker);
      const reports = await bounded(Promise.all(children.map(async child => {
        const [output, error, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect(error).toBe(''); expect(exitCode).toBe(0);
        return JSON.parse(output) as { pid: number; results: WagerResult[] };
      })));
      expect(new Set(reports.map(report => report.pid)).size).toBe(3);
      const results = reports.flatMap(report => report.results);
      expect(results).toHaveLength(50); expect(results.filter(result => !result.idempotentReplay)).toHaveLength(1);
      expect(results.filter(result => result.idempotentReplay)).toHaveLength(49);
      expect(new Set(results.map(result => result.transactionId)).size).toBe(1);
      for (const result of results) expect(result).toMatchObject({ status: 'PROCESSED', balance: { amount: '140.50' } });
      expect((await app`SELECT balance::text,version::text FROM wallets`)[0]).toEqual({ balance: '140.50', version: '2' });
      expect((await app`SELECT count(*)::text n FROM wager_transactions WHERE kind='WIN'`)[0].n).toBe('1');
      expect((await app`SELECT count(*)::text n FROM wallet_ledger_entries WHERE wallet_version=2`)[0].n).toBe('1');
      expect((await app`SELECT count(*)::text n FROM wager_transaction_results`)[0].n).toBe('1');
      expect((await app`SELECT count(*)::text n FROM outbox_messages WHERE payload->'data'->>'transactionId'=${results[0]!.transactionId}`)[0].n).toBe('2');
      expect((await app`SELECT count(*)::text n FROM outbox_messages WHERE event_type='WagerTransactionProcessed' AND payload->'data'->>'kind'='WIN'`)[0].n).toBe('1');
      await assertReconciled(app);
    } finally {
      release.open(); await blocker;
      for (const child of children) if (child.exitCode === null) child.kill();
      await Promise.allSettled(children.map(child => child.exited));
    }
  });
}, 30000);
