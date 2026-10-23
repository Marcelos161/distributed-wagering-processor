import { expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message.js';
import { openingWithMessages, withMessagingDatabase } from './messaging-support.js';

function gate() {
  let open!: () => void;
  const ready = new Promise<void>(resolve => { open = resolve; });
  return { ready, open };
}
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_,reject) => {
    timer=setTimeout(()=>reject(new Error('Concurrent operation timed out')),5000);
  })]); } finally { clearTimeout(timer); }
}
async function observeWait(sql: SQL, table: string): Promise<void> {
  const deadline=Date.now()+4000;
  do {
    const rows=await sql`SELECT pid,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE ${'%' + table + '%'}
      AND cardinality(pg_blocking_pids(pid))>0`;
    if (rows[0]) { expect(rows[0].blockers[0]).not.toBe(rows[0].pid); return; }
    await Bun.sleep(10); // Poll only; actual pg_blocking_pids proves the wait.
  } while(Date.now()<deadline);
  throw new Error('No database lock wait observed');
}

test.each(['hash','different'])('concurrent Inbox waits then checks payload %s', async hash => {
  await withMessagingDatabase(async ({unit,app}) => {
    const held=gate(), release=gate();
    let second: Promise<unknown> | undefined;
    let independent: Promise<unknown> | undefined;
    const first=unit.run(async repos => { await openingWithMessages(repos); held.open(); await release.ready; })
      .then(()=>null,(error:unknown)=>error);
    try {
      await bounded(held.ready);
      second=unit.run(repos=>openingWithMessages(repos,'wallet',hash)).then(value=>value,(error:unknown)=>error);
      await observeWait(app,'inbox_messages');
      independent=unit.run(repos=>openingWithMessages(repos,'other')).then(value=>value,(error:unknown)=>error);
      expect(await bounded(independent)).toBe('applied');
      release.open(); expect(await bounded(first)).toBeNull();
      const result=await bounded(second);
      if(hash==='hash') expect(result).toBe('replay');
      else expect(result).toHaveProperty('code','INBOX_PAYLOAD_CONFLICT');
      expect((await app`SELECT count(*)::text AS n FROM wallet_ledger_entries WHERE wallet_id='wallet'`)[0].n).toBe('1');
      expect((await app`SELECT count(*)::text AS n FROM outbox_messages WHERE payload->'data'->>'walletId'='wallet'`)[0].n).toBe('2');
    } finally { release.open(); await Promise.allSettled([first,second,independent].filter(value=>value!==undefined)); }
  });
},30_000);

test('concurrent Outbox inserts wait and reject duplicate event identity', async () => {
  await withMessagingDatabase(async ({unit,app}) => {
    const held=gate(),release=gate(); let event: OutboxMessage | undefined; let second: Promise<unknown> | undefined;
    const first=unit.run(async repos=>{
      await openingWithMessages(repos); event=(await repos.outbox.findByIdForUpdate('processed-wallet'))!;
      held.open(); await release.ready;
    }).then(()=>null,(error:unknown)=>error);
    try {
      await bounded(held.ready);
      const copy=OutboxMessage.rehydrate({id:event!.id,aggregateId:event!.aggregateId,eventType:event!.eventType,
        payload:event!.payload,occurredAt:event!.occurredAt,attempts:0});
      second=unit.run(repos=>repos.outbox.insert(copy)).then(()=>null,(error:unknown)=>error);
      await observeWait(app,'outbox_messages'); release.open();
      expect(await bounded(first)).toBeNull(); expect(await bounded(second)).toHaveProperty('code','23505');
      expect((await app`SELECT count(*)::text AS n FROM outbox_messages WHERE id='processed-wallet'`)[0].n).toBe('1');
    } finally {release.open();await Promise.allSettled([first,second].filter(value=>value!==undefined));}
  });
},30_000);
