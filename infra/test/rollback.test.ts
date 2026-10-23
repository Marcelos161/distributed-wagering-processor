import { WagerTransactionStatus as Status } from '../../src/domain/wagering/wager-transaction.js';
import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { withOperationalDatabase } from './operational-support.js';
import { creator, fundedInput } from './wallet-creation-support.js';
import { betInput, processor } from './bet-processing-support.js';
import { refundInput } from './refund-support.js';
import { wagerInput, wagerState } from './wager-support.js';
import { assertReconciled, gate, bounded } from './bet-support.js';
import type { WagerResult } from '../../src/application/wagering/wager-result.js';
import { insertTransaction } from './financial-schema-support.js';

test.each(['BET', 'WIN', 'REFUND'] as const)('ROLLBACK %s applies exact opposite and preserves historical replay', async kind => {
  await withOperationalDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute(fundedInput), useCase = processor(unit);
    if (kind === 'REFUND') await useCase.execute(betInput(wallet.id));
    const original = kind === 'REFUND' ? refundInput(wallet.id) : kind === 'WIN'
      ? wagerInput(wallet.id, 'WIN', { externalTransactionId: 'win', idempotencyKey: 'win', money: { amount: '25.00', currency: 'BRL' } }) : betInput(wallet.id);
    await useCase.execute(original);
    const input = refundInput(wallet.id, { kind: 'ROLLBACK', externalTransactionId: 'rollback', idempotencyKey: 'rollback', referenceExternalTransactionId: original.externalTransactionId });
    const result = await useCase.execute(input);
    expect(result).toMatchObject({ status: 'PROCESSED', balance: { amount: kind === 'REFUND' ? '75.00' : '100.00' } });
    expect((await app`SELECT direction FROM wallet_ledger_entries WHERE transaction_id=${result.transactionId}`)[0].direction).toBe(kind === 'BET' ? 'CREDIT' : 'DEBIT');
    await useCase.execute(betInput(wallet.id, { externalTransactionId: 'later', idempotencyKey: 'later' }));
    const before = await wagerState(app); expect(await useCase.execute(input)).toEqual({ ...result, idempotentReplay: true });
    expect(await wagerState(app)).toEqual(before); await assertReconciled(app);
  });
});

test.each(['WIN', 'REFUND'] as const)('ROLLBACK %s rejects insufficient funds with reversal code', async kind => {
  await withOperationalDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute(fundedInput), useCase = processor(unit);
    await useCase.execute(betInput(wallet.id));
    const target = kind === 'REFUND' ? refundInput(wallet.id) : wagerInput(wallet.id, 'WIN', { externalTransactionId: 'win', idempotencyKey: 'win', money: { amount: '25.00', currency: 'BRL' } });
    await useCase.execute(target);
    await useCase.execute(betInput(wallet.id, { externalTransactionId: 'drain', idempotencyKey: 'drain', money: { amount: '100.00', currency: 'BRL' } }));
    const result = await useCase.execute(refundInput(wallet.id, { kind: 'ROLLBACK', externalTransactionId: 'reverse', idempotencyKey: 'reverse', referenceExternalTransactionId: target.externalTransactionId }));
    expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'REVERSAL_INSUFFICIENT_FUNDS', balance: { amount: '0.00' } });
    expect(await app`SELECT id FROM wallet_ledger_entries WHERE transaction_id=${result.transactionId}`).toEqual([]); await assertReconciled(app);
  });
});

test.each(['REFUND', 'ROLLBACK'] as const)('%s of BET permanently reserves compensation across types', async firstKind => {
  await withOperationalDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute(fundedInput), useCase = processor(unit);
    await useCase.execute(betInput(wallet.id));
    const first = await useCase.execute(refundInput(wallet.id, { kind: firstKind }));
    if (firstKind === 'REFUND') {
      expect((await useCase.execute(refundInput(wallet.id, { kind: 'ROLLBACK', externalTransactionId: 'undo-refund', idempotencyKey: 'undo-refund', referenceExternalTransactionId: 'refund' }))).status).toBe(Status.Processed);
    }
    for (const kind of ['REFUND', 'ROLLBACK'] as const) {
      const result = await useCase.execute(refundInput(wallet.id, { kind, externalTransactionId: kind, idempotencyKey: kind }));
      expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'DUPLICATE_REVERSAL' });
    }
    await expect(unit.run(async repos => {
      // Direct SQL below also tests protection without the application availability check.
      expect((await repos.transactions.findById(first.transactionId))?.status).toBe(Status.Processed);
      throw new Error('test rollback');
    })).rejects.toThrow('test rollback');
    await expect(insertTransaction(app, { id: 'bypass', wallet: wallet.id, player: 'player', round: 'round',
      kind: firstKind === 'REFUND' ? 'ROLLBACK' : 'REFUND', status: 'PROCESSED', externalReference: 'external-1',
      reference: (await app`SELECT id FROM wager_transactions WHERE kind='BET'`)[0].id })).rejects.toHaveProperty('constraint', 'wager_single_compensation_unique');
    await assertReconciled(app);
  });
});

test.each(['missing', 'partial', 'invalid', 'overflow'] as const)('ROLLBACK handles %s without partial movement', async scenario => {
  await withOperationalDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute(scenario === 'overflow' ? { ...fundedInput, initialBalance: { amount: '999999999999999999.99', currency: 'BRL' } } : fundedInput);
    const useCase = processor(unit);
    if (scenario !== 'missing') await useCase.execute(betInput(wallet.id, scenario === 'invalid' ? { money: { amount: '101.00', currency: 'BRL' } } : {}));
    if (scenario === 'overflow') await useCase.execute(wagerInput(wallet.id, 'WIN', { externalTransactionId: 'win', idempotencyKey: 'win', money: { amount: '25.00', currency: 'BRL' } }));
    const result = await useCase.execute(refundInput(wallet.id, { kind: 'ROLLBACK', money: { amount: scenario === 'partial' ? '10.00' : '25.00', currency: 'BRL' } }));
    expect(result.status).toBe(scenario === 'missing' ? Status.PendingReference : Status.Rejected);
    if (scenario !== 'missing') expect(result).toHaveProperty('failureCode', scenario === 'overflow' ? 'DOMAIN_RULE_VIOLATION' : 'INVALID_REFERENCE');
    expect(await app`SELECT id FROM wallet_ledger_entries WHERE transaction_id=${result.transactionId}`).toEqual([]); await assertReconciled(app);
  });
});

test('REFUND and ROLLBACK race in independent Bun processes with one compensation', async () => {
  await withOperationalDatabase(async ({ unit, app, applicationUrl }) => {
    const wallet = await creator(unit).execute(fundedInput); await processor(unit).execute(betInput(wallet.id));
    const held = gate(), release = gate();
    const blocker = unit.run(async repos => { await repos.wallets.findByIdForUpdate(wallet.id); held.open(); await release.ready; });
    await held.ready;
    const children = ['REFUND', 'ROLLBACK'].map(kind => {
      const url = new URL(applicationUrl); url.searchParams.set('application_name', `compensation-${kind}`);
      return Bun.spawn([process.execPath, fileURLToPath(new URL('./bet-worker.ts', import.meta.url))], { stdout: 'pipe', stderr: 'pipe',
        env: { ...process.env, DWP_BET_DB: url.href, DWP_BET_COUNT: '1', DWP_BET_INPUT: JSON.stringify(refundInput(wallet.id, { kind: kind as 'REFUND' | 'ROLLBACK', externalTransactionId: kind, idempotencyKey: kind })) } });
    });
    try {
      const until = Date.now() + 6000; let count = 0;
      do {
        count = (await app`SELECT DISTINCT application_name FROM pg_stat_activity WHERE datname=current_database() AND application_name LIKE 'compensation-%' AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0`).length;
        if (count === 2) break; await Bun.sleep(10);
      } while (Date.now() < until);
      expect(count).toBe(2); release.open(); await blocker;
      const reports = await bounded(Promise.all(children.map(async child => {
        const [body, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect(code).toBe(0); expect(errors).toBe(''); return JSON.parse(body.trim().split('\n').at(-1)!) as { pid: number; results: WagerResult[] };
      })));
      expect(new Set(reports.map(r => r.pid)).size).toBe(2);
      expect(reports.flatMap(r => r.results).map(r => r.status).sort()).toEqual([Status.Processed, Status.Rejected]);
      expect((await app`SELECT balance::text,version::text FROM wallets`)[0]).toEqual({ balance: '100.00', version: '3' }); await assertReconciled(app);
    } finally { release.open(); await blocker; for (const child of children) if (child.exitCode === null) child.kill(); await Promise.allSettled(children.map(c => c.exited)); }
  });
}, 30000);

test('ROLLBACK migration downgrade preserves old responses and refuses new terminal or pending history', async () => {
  await withOperationalDatabase(async ({ unit, app, orm }) => {
    const wallet = await creator(unit).execute(fundedInput), useCase = processor(unit);
    await useCase.execute(betInput(wallet.id)); const before = await wagerState(app);
    await orm.migrator.down({ to: 'Migration20261023000007' }); expect(await wagerState(app)).toEqual(before);
    await orm.migrator.up(); expect(await orm.migrator.up()).toEqual([]); expect(await wagerState(app)).toEqual(before);
    await useCase.execute(refundInput(wallet.id, { kind: 'ROLLBACK', referenceExternalTransactionId: 'absent' }));
    await expect(orm.migrator.down({ to: 'Migration20261023000007' })).rejects.toHaveProperty('code', '55000');
    await assertReconciled(app);
  });
});

test('ROLLBACK ledger failure aborts wallet transaction result and outbox together', async () => {
  await withOperationalDatabase(async ({ unit, app, owner }) => {
    const wallet = await creator(unit).execute(fundedInput), useCase = processor(unit);
    await useCase.execute(betInput(wallet.id)); const before = await wagerState(app);
    await owner.unsafe(`CREATE FUNCTION fail_rollback() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected ledger fault' USING ERRCODE='P0001'; END $$;
      CREATE TRIGGER fail_rollback BEFORE INSERT ON wallet_ledger_entries FOR EACH ROW EXECUTE FUNCTION fail_rollback()`);
    await expect(useCase.execute(refundInput(wallet.id, { kind: 'ROLLBACK' }))).rejects.toHaveProperty('code', 'P0001');
    expect(await wagerState(app)).toEqual(before); await assertReconciled(app);
  });
});
