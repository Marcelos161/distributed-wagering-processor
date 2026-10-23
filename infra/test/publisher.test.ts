import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { OutboxDispatch } from '../../src/infrastructure/persistence/financial/outbox-dispatch.js';
import { PublishOutbox } from '../../src/infrastructure/messaging/publish-outbox.js';
import { sqsClient } from '../../src/infrastructure/messaging/sqs-connection.js';
import { withOperationalDatabase } from './operational-support.js';
import { withQueues, receive } from './queue-support.js';
import { creator, fundedInput } from './wallet-creation-support.js';
import { assertReconciled, bounded, readUntil } from './bet-support.js';
import { createHash } from 'node:crypto';

test('two publishers claim disjoint events, send real SQS and mark only after confirmation', async () => {
  await withOperationalDatabase(async ({ unit, app, appOrm }) => withQueues(async ({ client, source, name }) => {
    await creator(unit).execute(fundedInput);
    const first = new PublishOutbox(new OutboxDispatch(appOrm, 60000), client, name, 'commands.fifo');
    const second = new PublishOutbox(new OutboxDispatch(appOrm, 60000), client, name, 'commands.fifo');
    expect(await Promise.all([first.runOne(), second.runOne()])).toEqual([true, true]);
    expect(await first.runOne()).toBe(false);
    expect((await app`SELECT count(*)::text n FROM outbox_messages WHERE published_at IS NOT NULL`)[0].n).toBe('2');
    const messages = await receive(client, source); expect(messages).toHaveLength(2);
    expect(new Set(messages.map(m => (JSON.parse(m.Body!) as { eventId: string }).eventId)).size).toBe(2);
    expect((await app`SELECT count(*)::text n FROM outbox_claims`)[0].n).toBe('0'); await assertReconciled(app);
  }));
});

test('SQS unavailable schedules retry and expired publisher cannot overwrite new owner', async () => {
  await withOperationalDatabase(async ({ unit, app, appOrm }) => withQueues(async ({ client, name }) => {
    await creator(unit).execute(fundedInput);
    const bad = sqsClient({ SQS_ENDPOINT: 'http://127.0.0.1:1' });
    try { await expect(new PublishOutbox(new OutboxDispatch(appOrm, 60000), bad, name, 'commands').runOne()).rejects.toThrow(); }
    finally { bad.destroy(); }
    expect((await app`SELECT count(*)::text n FROM outbox_messages WHERE attempts=1 AND published_at IS NULL AND next_attempt_at IS NOT NULL`)[0].n).toBe('1');
    const short = new OutboxDispatch(appOrm, 1), old = (await short.claim())!;
    // Database clock proves lease expiration; no guessed delay is the assertion.
    let expired = false;
    while (!expired) expired = (await app`SELECT lease_until<clock_timestamp() expired FROM outbox_claims WHERE event_id=${old.message.id}`)[0].expired;
    const next = (await new OutboxDispatch(appOrm, 60000).claim())!;
    expect(next.message.id).toBe(old.message.id); expect(next.token).not.toBe(old.token);
    expect(await short.finish(old, true)).toBe(false);
    await new OutboxDispatch(appOrm, 60000).finish(next, false);
    const publisher = new PublishOutbox(new OutboxDispatch(appOrm, 60000), client, name, 'commands');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (await app`SELECT count(*)::text n FROM outbox_messages WHERE published_at IS NULL`)[0].n !== '0') { await publisher.runOne(); await Bun.sleep(20); }
    expect((await app`SELECT count(*)::text n FROM outbox_messages WHERE published_at IS NULL`)[0].n).toBe('0'); await assertReconciled(app);
  }));
});

test('publisher SIGKILL after broker send recovers lease; duplicate eventId is safe through persistent Inbox', async () => {
  await withOperationalDatabase(async ({ unit, app, appOrm, applicationUrl }) => withQueues(async ({ client, source, name }) => {
    await creator(unit).execute(fundedInput);
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./publisher-child.ts', import.meta.url))], { env: { ...process.env, DATABASE_URL: applicationUrl, SQS_EVENT_QUEUE_NAME: name }, stdout: 'pipe', stderr: 'pipe' });
    const errors = new Response(child.stderr).text();
    try {
      await readUntil(child.stdout, 'PUBLISHED_BEFORE_MARK');
      child.kill('SIGKILL'); await bounded(child.exited); expect(await errors).toBe('');
      expect((await app`SELECT count(*)::text n FROM outbox_messages WHERE published_at IS NOT NULL`)[0].n).toBe('0');
      const publisher = new PublishOutbox(new OutboxDispatch(appOrm, 60000), client, name, 'commands');
      const deadline = Date.now()+5000;
      while (Date.now()<deadline && (await app`SELECT count(*)::text n FROM outbox_messages WHERE published_at IS NULL`)[0].n !== '0') { await publisher.runOne(); await Bun.sleep(20); }
      expect((await app`SELECT count(*)::text n FROM outbox_messages WHERE published_at IS NOT NULL`)[0].n).toBe('2');
      const events = await receive(client, source); expect(events.length).toBeGreaterThanOrEqual(1);
      const body = events[0]!.Body!, envelope = JSON.parse(body) as { eventId: string };
      // Force another delivery outside the FIFO dedup key, proving Inbox rather than broker-only dedup.
      await client.send(new SendMessageCommand({ QueueUrl: source, MessageBody: body, MessageGroupId: 'duplicate-test', MessageDeduplicationId: crypto.randomUUID() }));
      const duplicate = (await receive(client, source)).find(m => m.Body === body); expect(duplicate).toBeDefined();
      let effects = 0;
      for (const event of [events[0]!, duplicate!]) await unit.run(async repos => {
        const received = await repos.inbox.receive({ consumerName: 'event-audit-v1', messageId: envelope.eventId, payloadHash: createHash('sha256').update(event.Body!).digest('hex'), receivedAt: new Date() });
        if (received.disposition !== 'processed') { effects++; received.message.markProcessed(new Date()); await repos.inbox.save(received.message); }
      });
      expect(effects).toBe(1); expect((await app`SELECT balance::text FROM wallets`)[0].balance).toBe('100.00'); await assertReconciled(app);
    } finally { if (child.exitCode === null) child.kill('SIGKILL'); await child.exited; }
  }));
}, 20000);
