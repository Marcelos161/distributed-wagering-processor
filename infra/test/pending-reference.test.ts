import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { ResolvePendingReferences } from '../../src/application/wagering/resolve-pending-references.js';
import { withOperationalDatabase } from './operational-support.js';
import { creator, fundedInput } from './wallet-creation-support.js';
import { processor, betInput, betTime } from './bet-processing-support.js';
import { refundInput } from './refund-support.js';
import { assertReconciled, bounded, gate, observeWait } from './bet-support.js';
import type { FinancialUnitOfWork } from '../../src/application/ports/financial-persistence.js';

const policy = { maxAttempts: 3, ttlMs: 86400000, initialDelayMs: 1000, maxDelayMs: 2000 };
test.each(['WIN', 'REFUND', 'ROLLBACK'] as const)('durable worker resolves %s after reference arrives and keeps receipt', async kind => {
  await withOperationalDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute(fundedInput), useCase = processor(unit), input = refundInput(wallet.id, { kind });
    const pending = await useCase.execute(input); let now = betTime;
    const worker = new ResolvePendingReferences(unit, useCase, { now: () => now }, policy);
    expect(await worker.runOne()).toBe(true); expect(await worker.runOne()).toBe(false);
    await useCase.execute(betInput(wallet.id)); now = new Date(now.getTime() + 1000);
    expect(await worker.runOne()).toBe(true); expect(await worker.runOne()).toBe(false);
    expect(await useCase.execute(input)).toMatchObject({ transactionId: pending.transactionId, status: 'PROCESSED', balance: { amount: '100.00' }, idempotentReplay: true });
    expect((await app`SELECT attempts,completed_at FROM pending_reference_jobs`)[0].attempts).toBe(2);
    expect((await app`SELECT count(*)::text n FROM wager_pending_receipts`)[0].n).toBe('1');
    expect((await app`SELECT count(*)::text n FROM outbox_messages WHERE aggregate_id=${pending.transactionId}`)[0].n).toBe('2'); await assertReconciled(app);
  });
});

test.each(['attempts', 'ttl', 'invalid'] as const)('reference worker persists %s rejection and historical replay', async reason => {
  await withOperationalDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute(fundedInput), useCase = processor(unit), input = refundInput(wallet.id);
    const pending = await useCase.execute(input);
    if (reason === 'invalid') await useCase.execute(betInput(wallet.id, { money: { amount: '101.00', currency: 'BRL' } }));
    const worker = new ResolvePendingReferences(unit, useCase, { now: () => new Date(betTime.getTime() + (reason === 'ttl' ? 86400001 : 0)) }, { ...policy, maxAttempts: reason === 'attempts' ? 1 : 3 });
    expect(await worker.runOne()).toBe(true);
    expect(await useCase.execute(input)).toMatchObject({ transactionId: pending.transactionId, status: 'REJECTED', failureCode: reason === 'invalid' ? 'INVALID_REFERENCE' : 'REFERENCE_NOT_FOUND', idempotentReplay: true });
    expect((await app`SELECT count(*)::text n FROM wallet_ledger_entries`)[0].n).toBe('1'); await assertReconciled(app);
  });
});

test('two reference workers skip the same durable job and rollback retains scheduling', async () => {
  await withOperationalDatabase(async ({ unit, app }) => {
    const wallet = await creator(unit).execute(fundedInput), useCase = processor(unit); await useCase.execute(refundInput(wallet.id));
    await useCase.execute(betInput(wallet.id)); const held = gate(), release = gate();
    const faulty: FinancialUnitOfWork = { run: work => unit.run(async repos => { await work(repos); held.open(); await release.ready; throw new Error('crash boundary'); }) };
    const first = new ResolvePendingReferences(faulty, useCase, { now: () => betTime }, policy).runOne().catch((error: unknown) => error);
    try {
      await bounded(held.ready);
      const worker = new ResolvePendingReferences(unit, useCase, { now: () => betTime }, policy);
      expect(await bounded(worker.runOne())).toBe(false);
      release.open(); expect(await first).toBeInstanceOf(Error);
      expect((await app`SELECT attempts FROM pending_reference_jobs`)[0].attempts).toBe(0);
      expect(await worker.runOne()).toBe(true); expect((await app`SELECT balance::text FROM wallets`)[0].balance).toBe('100.00'); await assertReconciled(app);
    } finally { release.open(); await first; }
  });
});

test('reference worker process killed while holding a claim resumes after restart and SIGTERM drains', async () => {
  await withOperationalDatabase(async ({ unit, app, applicationUrl }) => {
    const wallet = await creator(unit).execute(fundedInput), useCase = processor(unit); await useCase.execute(refundInput(wallet.id)); await useCase.execute(betInput(wallet.id));
    const held = gate(), release = gate();
    const blocker = unit.run(async repos => { await repos.wallets.findByIdForUpdate(wallet.id); held.open(); await release.ready; }); await held.ready;
    const spawn = () => Bun.spawn([process.execPath, fileURLToPath(new URL('../../src/reference-worker.ts', import.meta.url))], {
      env: { ...process.env, DATABASE_URL: applicationUrl }, stdout: 'ignore', stderr: 'pipe',
    });
    let child = spawn(); const errors: Promise<string>[] = [new Response(child.stderr).text()];
    try {
      await observeWait(app, 'FOR NO KEY UPDATE'); child.kill('SIGKILL'); await bounded(child.exited); release.open(); await blocker;
      expect((await app`SELECT attempts FROM pending_reference_jobs`)[0].attempts).toBe(0);
      child = spawn(); errors.push(new Response(child.stderr).text());
      const deadline = Date.now() + 8000; let done = false;
      do { done = (await app`SELECT completed_at FROM pending_reference_jobs`)[0].completed_at !== null;
        if (done) break; await Bun.sleep(20);
      } while (Date.now() < deadline);
      expect(done).toBe(true); child.kill('SIGTERM'); expect(await bounded(child.exited)).toBe(0);
      expect(await Promise.all(errors)).toEqual(['', '']); await assertReconciled(app);
    } finally { release.open(); await blocker; if (child.exitCode === null) child.kill('SIGKILL'); await child.exited; }
  });
}, 30000);

test('pending ROLLBACK checks current funds and a PostgreSQL fault retains the durable claim', async () => {
  await withOperationalDatabase(async ({ unit, app, owner }) => {
    const wallet = await creator(unit).execute(fundedInput), useCase = processor(unit);
    const input = refundInput(wallet.id, { kind: 'ROLLBACK', referenceExternalTransactionId: 'win' });
    await useCase.execute(input);
    await useCase.execute({ ...betInput(wallet.id), kind: 'WIN', externalTransactionId: 'win', idempotencyKey: 'win' });
    await useCase.execute(betInput(wallet.id, { money: { amount: '125.00', currency: 'BRL' } }));
    await owner.unsafe(`CREATE FUNCTION fail_reference() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'transient test fault' USING ERRCODE='40001'; END $$;
      CREATE TRIGGER fail_reference BEFORE INSERT ON wager_transaction_results FOR EACH ROW EXECUTE FUNCTION fail_reference()`);
    const worker = new ResolvePendingReferences(unit, useCase, { now: () => betTime }, policy);
    await expect(worker.runOne()).rejects.toThrow();
    expect((await app`SELECT attempts,completed_at FROM pending_reference_jobs`)[0]).toEqual({ attempts: 0, completed_at: null });
    await owner.unsafe('DROP FUNCTION fail_reference() CASCADE');
    expect(await worker.runOne()).toBe(true);
    expect(await useCase.execute(input)).toMatchObject({ status: 'REJECTED', failureCode: 'REVERSAL_INSUFFICIENT_FUNDS', balance: { amount: '0.00' }, idempotentReplay: true });
    await assertReconciled(app);
  });
});
