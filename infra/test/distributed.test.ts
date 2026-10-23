import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { withOperationalDatabase } from './operational-support.js';
import { withQueues, send } from './queue-support.js';
import { creator, fundedInput } from './wallet-creation-support.js';
import { betInput } from './bet-processing-support.js';
import { assertReconciled, gate, bounded, readUntil } from './bet-support.js';
import { FinancialQueries } from '../../src/application/queries/financial-queries.js';

function child(entry: string, env: Record<string, string | undefined>) {
  return Bun.spawn([process.execPath, fileURLToPath(new URL('../../src/'+entry, import.meta.url))], { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
}
async function waitFor(check: () => Promise<boolean>, milliseconds = 10000): Promise<void> {
  const deadline = Date.now()+milliseconds;
  do { if (await check()) return; await Bun.sleep(20); } while (Date.now()<deadline);
  throw new Error('Distributed milestone not observed');
}
async function stop(processes: ReturnType<typeof child>[], nest = false) {
  for (const process of processes) if (process.exitCode === null) process.kill('SIGTERM');
  await Promise.all(processes.map(async process => {
    const code = await Promise.race([process.exited, Bun.sleep(16000).then(() => -1)]);
    if (code === -1) process.kill('SIGKILL'); await process.exited; expect(nest ? [0,143].includes(code) : code === 0).toBe(true);
  }));
}
async function startApi(database: string) {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() }), port = probe.port!; probe.stop(true);
  const process = child('main.ts', { DATABASE_URL: database, PORT: String(port), HOST: '127.0.0.1' });
  const output = new Response(process.stdout).text(), errors = new Response(process.stderr).text(), url = `http://127.0.0.1:${port}`;
  try { await waitFor(async () => { try { return (await fetch(url+'/health/ready')).ok; } catch { return false; } }); }
  catch (error) { process.kill('SIGKILL'); await process.exited; throw error; }
  return { process, output, errors, url };
}
async function post(url: string, walletId: string, external: string, amount: string, kind: string = 'BET', reference?: string) {
  const { idempotencyKey: _, ...input } = betInput(walletId);
  const response = await fetch(url+'/wagering/transactions', { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': external },
    body: JSON.stringify({ ...input, externalTransactionId: external, kind, money: { amount, currency: 'BRL' }, ...(reference ? { referenceExternalTransactionId: reference } : {}) }) });
  return { status: response.status, data: await response.json() as { status: string; balance: { amount: string }; idempotentReplay: boolean; transactionId: string } };
}

test('three real HTTP servers: 50 duplicates, 80+80 race, independent wallets, compensation race and restart replay', async () => {
  await withOperationalDatabase(async ({ unit, app, applicationUrl }) => {
    const servers = await Promise.all([0,1,2].map(() => startApi(applicationUrl)));
    try {
      expect(new Set(servers.map(s => s.process.pid)).size).toBe(3);
      const wallet = await creator(unit).execute(fundedInput);
      const replies = await Promise.all(Array.from({ length: 50 }, (_, i) => post(servers[i%3]!.url, wallet.id, 'same', '25.00')));
      expect(replies.filter(r => !r.data.idempotentReplay)).toHaveLength(1); expect(new Set(replies.map(r => r.data.transactionId)).size).toBe(1);
      for (const result of replies) { expect(result.status).toBe(200); expect(result.data.balance.amount).toBe('75.00'); }
      const race = await creator(unit, 'race-wallet').execute({ playerId: 'player', initialBalance: { amount: '100.00', currency: 'USD' } });
      // Replenish the existing BRL wallet; the USD wallet proves independent progress below.
      await post(servers[0]!.url, wallet.id, 'top-up', '25.00', 'WIN');
      const outcomes = await Promise.all([post(servers[0]!.url, wallet.id, 'bet-a', '80.00'), post(servers[1]!.url, wallet.id, 'bet-b', '80.00')]);
      expect(outcomes.map(r=>r.status).sort()).toEqual([200,422]);
      expect((await app`SELECT balance::text FROM wallets WHERE id=${wallet.id}`)[0].balance).toBe('20.00');
      expect((await app`SELECT count(*)::text n FROM wallet_ledger_entries WHERE wallet_id=${wallet.id} AND direction='DEBIT' AND amount=80`)[0].n).toBe('1');
      const winner = outcomes[0]!.status === 200 ? 'bet-a' : 'bet-b';
      const reversals = await Promise.all([post(servers[0]!.url, wallet.id, 'refund', '80.00', 'REFUND', winner), post(servers[2]!.url, wallet.id, 'rollback', '80.00', 'ROLLBACK', winner)]);
      expect(reversals.map(r=>r.status).sort()).toEqual([200,422]);
      expect((await app`SELECT balance::text FROM wallets WHERE id=${wallet.id}`)[0].balance).toBe('100.00');
      const held=gate(), release=gate();
      const lock = unit.run(async repos => { await repos.wallets.findByIdForUpdate(wallet.id); held.open(); await release.ready; }); await held.ready;
      try {
        const { idempotencyKey: _, ...independent } = betInput(race.id);
        const response = await fetch(servers[2]!.url+'/wagering/transactions', { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'independent' },
          body: JSON.stringify({ ...independent, externalTransactionId: 'independent', kind: 'WIN', money: { amount: '10.00', currency: 'USD' } }) });
        expect(response.status).toBe(200); expect((await response.json() as {balance:{amount:string}}).balance.amount).toBe('110.00');
      } finally { release.open(); await lock; }
      await stop([servers[0]!.process], true); expect(await servers[0]!.errors).toBe(''); servers[0] = await startApi(applicationUrl);
      expect((await post(servers[0]!.url, wallet.id, 'same', '25.00')).data).toMatchObject({ balance: { amount: '75.00' }, idempotentReplay: true });
      expect((await new FinancialQueries(unit).reconcile(wallet.id)).consistent).toBe(true); await assertReconciled(app);
    } finally { await stop(servers.map(s=>s.process), true); for (const server of servers) { expect(await server.errors).toBe(''); await server.output; } }
  });
}, 60000);

test('three SQS processes killed before commit recover messages, then two publisher processes drain confirmed events', async () => {
  await withOperationalDatabase(async ({ unit, app, applicationUrl }) => withQueues(async ({ client, source, name }) => withQueues(async events => {
    const wallet = await creator(unit).execute(fundedInput), held = gate(), release = gate();
    const blocker = unit.run(async repos => { await repos.wallets.findByIdForUpdate(wallet.id); held.open(); await release.ready; }); await held.ready;
    for (const id of ['a','b','c']) await send(client, source, { messageId: id, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(),
      data: { ...betInput(wallet.id), externalTransactionId: id, idempotencyKey: id, kind: id==='c' ? 'LOSS' : 'BET', money: { amount: id==='c' ? '0.00' : '80.00', currency: 'BRL' } } });
    let workers = [0,1,2].map(() => child('consumer.ts', { DATABASE_URL: applicationUrl, SQS_QUEUE_NAME: name, SQS_VISIBILITY_SECONDS: '1' }));
    let drains = workers.map(p => ({ out: new Response(p.stdout).text(), err: new Response(p.stderr).text() }));
    try {
      await waitFor(async () => (await app`SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND application_name='wager-consumer' AND wait_event_type='Lock'`)[0].n === 3);
      expect(new Set(workers.map(p=>p.pid)).size).toBe(3);
      for (const process of workers) process.kill('SIGKILL'); await Promise.all(workers.map(p=>p.exited));
      for (const drain of drains) { expect(await drain.err).toBe(''); await drain.out; }
      expect((await app`SELECT count(*)::text n FROM inbox_messages`)[0].n).toBe('0');
      expect((await app`SELECT balance::text FROM wallets`)[0].balance).toBe('100.00'); release.open(); await blocker;
      workers = [0,1,2].map(() => child('consumer.ts', { DATABASE_URL: applicationUrl, SQS_QUEUE_NAME: name, SQS_VISIBILITY_SECONDS: '1' }));
      drains = workers.map(p=>({ out: new Response(p.stdout).text(), err: new Response(p.stderr).text() }));
      await waitFor(async () => (await app`SELECT count(*)::text n FROM inbox_messages WHERE processed_at IS NOT NULL`)[0].n === '3');
      expect((await app`SELECT balance::text FROM wallets`)[0].balance).toBe('20.00');
      expect((await app`SELECT count(*)::text n FROM wallet_ledger_entries WHERE direction='DEBIT'`)[0].n).toBe('1');
      await stop(workers); for (const drain of drains) { expect(await drain.err).toBe(''); await drain.out; }
      workers = [0,1].map(() => child('publisher.ts', { DATABASE_URL: applicationUrl, SQS_EVENT_QUEUE_NAME: events.name, SQS_QUEUE_NAME: name }));
      drains = workers.map(p=>({ out: new Response(p.stdout).text(), err: new Response(p.stderr).text() }));
      await waitFor(async () => (await app`SELECT count(*)::text n FROM outbox_messages WHERE published_at IS NULL`)[0].n === '0');
      await stop(workers); for (const drain of drains) { expect(await drain.err).toBe(''); await drain.out; }
      await assertReconciled(app);
    } finally { release.open(); await blocker; for (const p of workers) if (p.exitCode === null) p.kill('SIGKILL'); await Promise.all(workers.map(p=>p.exited)); }
  })));
}, 60000);

test('worker readiness endpoints reflect role dependencies and graceful termination', async () => {
  await withOperationalDatabase(async ({ applicationUrl }) => {
    const worker = child('reference-worker.ts', { DATABASE_URL: applicationUrl }); const errors = new Response(worker.stderr).text();
    try {
      const line = await readUntil(worker.stdout, 'started'); const started = JSON.parse(line.trim().split('\n').at(-1)!) as { healthPort: number };
      const base = 'http://127.0.0.1:'+started.healthPort;
      for (const path of ['/health/live','/health/ready','/metrics']) { const response = await fetch(base+path); expect(response.status).toBe(200); await response.text(); }
      worker.kill('SIGTERM'); expect(await bounded(worker.exited)).toBe(0); expect(await errors).toBe('');
    } finally { if (worker.exitCode === null) worker.kill('SIGKILL'); await worker.exited; }
  });
});
