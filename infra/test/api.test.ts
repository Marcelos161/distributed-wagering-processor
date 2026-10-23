import { expect, test } from 'bun:test';
import { createApplication } from '../../src/create-application.js';
import { withOperationalDatabase } from './operational-support.js';
import { assertReconciled } from './bet-support.js';
import { betInput } from './bet-processing-support.js';

async function withApi(run: (url: string, db: Parameters<Parameters<typeof withOperationalDatabase>[0]>[0]) => Promise<void>) {
  await withOperationalDatabase(async db => {
    const saved = process.env['DATABASE_URL']; process.env['DATABASE_URL'] = db.applicationUrl;
    const app = await createApplication({ logger: false });
    try { await app.listen(0, '127.0.0.1'); await run(await app.getUrl(), db); }
    finally { await app.close(); if (saved === undefined) delete process.env['DATABASE_URL']; else process.env['DATABASE_URL'] = saved; }
  });
}
async function request(url: string, path: string, body?: unknown, key?: string) {
  const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-correlation-id': 'api-test', ...(key ? { 'Idempotency-Key': key } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, correlation: response.headers.get('x-correlation-id'), body: await response.json() as Record<string, any> };
}
function payload(walletId: string, patch: Record<string, unknown> = {}) {
  const { idempotencyKey: _, ...input } = betInput(walletId); return { ...input, ...patch };
}
test('HTTP routes create query paginate reconcile and preserve wager replay', async () => {
  await withApi(async (url, { app }) => {
    const opening = await request(url, '/wallets', { playerId: 'player', initialBalance: { amount: '100.00', currency: 'BRL' } });
    expect(opening.status).toBe(201); expect(opening.correlation).toBe('api-test'); const id = opening.body.id as string;
    expect((await request(url, '/wallets', { playerId: 'player', initialBalance: { amount: '0.00', currency: 'BRL' } })).status).toBe(409);
    expect((await request(url, `/wallets/${id}`)).body.balance.amount).toBe('100.00');
    const bet = await request(url, '/wagering/transactions', payload(id), 'bet'); expect(bet.status).toBe(200);
    expect((await request(url, `/wagering/transactions/${bet.body.transactionId}`)).body.kind).toBe('BET');
    expect((await request(url, '/providers/provider-a/wagering/transactions/external-1')).body.id).toBe(bet.body.transactionId);
    for (let i = 0; i < 10; i++) expect((await request(url, '/wagering/transactions', payload(id, { kind: 'WIN', externalTransactionId: 'win'+i, money: { amount: '1.00', currency: 'BRL' } }), 'win'+i)).status).toBe(200);
    expect((await request(url, '/wagering/transactions', payload(id), 'bet')).body).toEqual({ ...bet.body, idempotentReplay: true });
    let cursor: string | null = null; const versions: number[] = [];
    do { const page = await request(url, `/wallets/${id}/ledger?limit=3${cursor ? '&cursor='+cursor : ''}`);
      expect(page.status).toBe(200); versions.push(...page.body.items.map((e: { walletVersion: number }) => e.walletVersion)); cursor = page.body.nextCursor;
    } while (cursor);
    expect(versions).toEqual(Array.from({ length: 12 }, (_, i) => i+1));
    const reconciliation = await request(url, `/wallets/${id}/reconciliation`, {});
    expect(reconciliation.status).toBe(200); expect(reconciliation.body).toMatchObject({ consistent: true, checkedEntries: 12, difference: { amount: '0.00' } });
    expect((await request(url, '/health/live')).status).toBe(200); expect((await request(url, '/health/ready')).status).toBe(200); await assertReconciled(app);
  });
}, 30000);

test('HTTP distinguishes invalid input conflict business rejection pending missing and sanitized errors', async () => {
  await withApi(async (url, { app }) => {
    const id = (await request(url, '/wallets', { playerId: 'player', initialBalance: { amount: '100.00', currency: 'BRL' } })).body.id as string;
    for (const body of [payload(id, { money: { amount: 25, currency: 'BRL' } }), payload(id, { kind: 'OPENING' }), payload(id, { extra: true }), payload(id, { idempotencyKey: 'body' }), payload(id, { providerId: 'x'.repeat(201) })]) {
      const response = await request(url, '/wagering/transactions', body, 'bad'); expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).not.toContain('stack');
    }
    expect((await request(url, '/wagering/transactions', payload(id))).status).toBe(400);
    const reject = await request(url, '/wagering/transactions', payload(id, { money: { amount: '101.00', currency: 'BRL' } }), 'reject');
    expect(reject.status).toBe(422); expect(reject.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect((await request(url, '/wagering/transactions', payload(id), 'reject')).status).toBe(409);
    expect((await request(url, '/wagering/transactions', payload(id), 'other')).status).toBe(409);
    const pending = await request(url, '/wagering/transactions', payload(id, { externalTransactionId: 'refund', kind: 'REFUND', referenceExternalTransactionId: 'absent' }), 'pending');
    expect(pending.status).toBe(202);
    expect((await request(url, '/wallets/absent')).status).toBe(404);
    expect((await request(url, '/wagering/transactions/absent')).status).toBe(404);
    for (const suffix of ['limit=0','limit=101','limit=1.5','cursor=%%%','cursor='+Buffer.from(JSON.stringify([1,'other',1])).toString('base64url')]) expect((await request(url, `/wallets/${id}/ledger?${suffix}`)).status).toBe(400);
    await assertReconciled(app);
  });
});

test('HTTP readiness fails when SQS is unavailable while liveness remains open', async () => {
  await withApi(async url => {
    const previous = process.env['SQS_ENDPOINT']; process.env['SQS_ENDPOINT'] = 'http://127.0.0.1:1';
    try {
      expect((await request(url, '/health/ready')).status).toBe(503);
      expect((await request(url, '/health/live')).status).toBe(200);
    } finally { if (previous === undefined) delete process.env['SQS_ENDPOINT']; else process.env['SQS_ENDPOINT'] = previous; }
  });
});
