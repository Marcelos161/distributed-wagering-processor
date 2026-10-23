import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { ChangeMessageVisibilityCommand } from '@aws-sdk/client-sqs';
import { ConsumeWager } from '../../src/infrastructure/messaging/consume-wager.js';
import { SystemClock } from '../../src/infrastructure/application/runtime.js';
import { withOperationalDatabase } from './operational-support.js';
import { withQueues, send, receive } from './queue-support.js';
import { creator, fundedInput } from './wallet-creation-support.js';
import { betInput, processor } from './bet-processing-support.js';
import { assertReconciled, bounded } from './bet-support.js';
function envelope(walletId: string, messageId = 'message', patch: Record<string, unknown> = {}) {
  return { messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data: { ...betInput(walletId), ...patch } };
}
test('SQS consumer persists Inbox and finance atomically, ACKs, and deduplicates across concurrent deliveries', async () => {
  await withOperationalDatabase(async ({ unit, app }) => withQueues(async ({ client, name, source }) => {
    const wallet = await creator(unit).execute(fundedInput), useCase = processor(unit);
    const consumer = () => new ConsumeWager(unit, useCase, new SystemClock(), client, { queueName: name, consumerName: 'wager-processor-v1', visibilitySeconds: 5, waitSeconds: 0, retrySeconds: 0 });
    for (let i = 0; i < 10; i++) await send(client, source, envelope(wallet.id));
    await Promise.all(Array.from({ length: 10 }, () => consumer().runOne()));
    expect((await app`SELECT balance::text FROM wallets`)[0].balance).toBe('75.00');
    expect((await app`SELECT count(*)::text n FROM inbox_messages WHERE processed_at IS NOT NULL`)[0].n).toBe('1');
    expect(await receive(client, source)).toEqual([]);
    await send(client, source, envelope(wallet.id, 'rejection', { externalTransactionId: 'reject', idempotencyKey: 'reject', money: { amount: '100.00', currency: 'BRL' } }));
    await consumer().runOne(); expect(await receive(client, source)).toEqual([]);
    expect((await app`SELECT count(*)::text n FROM wager_transactions WHERE status='REJECTED'`)[0].n).toBe('1'); await assertReconciled(app);
  }));
}, 20000);

test.each(['invalid', 'hash-conflict'] as const)('SQS %s remains unacked and reaches DLQ through real redrive policy', async reason => {
  await withOperationalDatabase(async ({ unit, app }) => withQueues(async ({ client, name, source, dlq }) => {
    const wallet = await creator(unit).execute(fundedInput), consumer = new ConsumeWager(unit, processor(unit), new SystemClock(), client,
      { queueName: name, consumerName: 'wager-processor-v1', visibilitySeconds: 1, waitSeconds: 0, retrySeconds: 0 });
    if (reason === 'hash-conflict') { await send(client, source, envelope(wallet.id)); await consumer.runOne(); }
    await send(client, source, reason === 'invalid' ? { bad: 'payload' } : envelope(wallet.id, 'message', { money: { amount: '5.00', currency: 'BRL' } }));
    for (let i = 0; i < 5; i++) await expect(consumer.runOne()).rejects.toThrow();
    await consumer.runOne(); expect(await receive(client, dlq)).toHaveLength(1);
    expect((await app`SELECT balance::text FROM wallets`)[0].balance).toBe(reason === 'invalid' ? '100.00' : '75.00'); await assertReconciled(app);
  }));
}, 20000);

test('SQS PostgreSQL failure before commit rolls back Inbox and allows redelivery', async () => {
  await withOperationalDatabase(async ({ unit, app, owner }) => withQueues(async ({ client, name, source }) => {
    const wallet = await creator(unit).execute(fundedInput), consumer = new ConsumeWager(unit, processor(unit), new SystemClock(), client,
      { queueName: name, consumerName: 'wager-processor-v1', visibilitySeconds: 1, waitSeconds: 0, retrySeconds: 0 });
    await owner.unsafe(`CREATE FUNCTION fail_consumer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'failure' USING ERRCODE='40001'; END $$;
      CREATE TRIGGER fail_consumer BEFORE INSERT ON wallet_ledger_entries FOR EACH ROW EXECUTE FUNCTION fail_consumer()`);
    await send(client, source, envelope(wallet.id)); await expect(consumer.runOne()).rejects.toThrow();
    expect((await app`SELECT count(*)::text n FROM inbox_messages`)[0].n).toBe('0'); expect((await app`SELECT balance::text FROM wallets`)[0].balance).toBe('100.00');
    await owner.unsafe('DROP FUNCTION fail_consumer() CASCADE'); await consumer.runOne();
    expect((await app`SELECT balance::text FROM wallets`)[0].balance).toBe('75.00'); expect(await receive(client, source)).toEqual([]); await assertReconciled(app);
  }));
});

test('consumer killed after COMMIT before ACK redelivers safely and real worker drains SIGTERM', async () => {
  await withOperationalDatabase(async ({ unit, app, applicationUrl }) => withQueues(async ({ client, name, source }) => {
    const wallet = await creator(unit).execute(fundedInput); await send(client, source, envelope(wallet.id));
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./consumer-child.ts', import.meta.url))], { env: { ...process.env, DATABASE_URL: applicationUrl, SQS_QUEUE_NAME: name }, stdout: 'pipe', stderr: 'pipe' });
    const errors = new Response(child.stderr).text();
    try {
      const reader = child.stdout.getReader(); const data = await bounded(reader.read());
      expect(new TextDecoder().decode(data.value)).toContain('COMMITTED_BEFORE_ACK'); reader.releaseLock();
      child.kill('SIGKILL'); await bounded(child.exited); expect(await errors).toBe('');
      expect((await app`SELECT balance::text FROM wallets`)[0].balance).toBe('75.00');
      // Wait for a real delivery, then make it visible for the restarted consumer.
      let messages = await receive(client, source); if (!messages.length) messages = await receive(client, source);
      expect(messages).toHaveLength(1); await client.send(new ChangeMessageVisibilityCommand({ QueueUrl: source, ReceiptHandle: messages[0]!.ReceiptHandle!, VisibilityTimeout: 0 }));
      const worker = Bun.spawn([process.execPath, fileURLToPath(new URL('../../src/consumer.ts', import.meta.url))], { env: { ...process.env, DATABASE_URL: applicationUrl, SQS_QUEUE_NAME: name }, stdout: 'pipe', stderr: 'pipe' });
      const workerErrors = new Response(worker.stderr).text();
      try {
        const startup = worker.stdout.getReader(); expect(new TextDecoder().decode((await bounded(startup.read())).value)).toContain('started'); startup.releaseLock();
        // A second sentinel message gives durable evidence of progress beyond the replay.
        await send(client, source, envelope(wallet.id, 'loss', { kind: 'LOSS', externalTransactionId: 'loss', idempotencyKey: 'loss', money: { amount: '0.00', currency: 'BRL' } }));
        const deadline = Date.now() + 8000; let count = '0';
        do { count = (await app`SELECT count(*)::text n FROM inbox_messages`)[0].n; if (count === '2') break; await Bun.sleep(20); } while (Date.now() < deadline);
        expect(count).toBe('2'); worker.kill('SIGTERM'); expect(await Promise.race([worker.exited, Bun.sleep(16000).then(() => -1)])).toBe(0);
        expect(await workerErrors).toBe(''); expect((await app`SELECT balance::text FROM wallets`)[0].balance).toBe('75.00'); await assertReconciled(app);
      } finally { if (worker.exitCode === null) worker.kill('SIGKILL'); await worker.exited; }
    } finally { if (child.exitCode === null) child.kill('SIGKILL'); await child.exited; }
  }));
}, 30000);
