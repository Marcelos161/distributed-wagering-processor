import type { SQL } from 'bun';
import type { FinancialUnitOfWork } from '../../src/application/ports/financial-persistence.js';
import type { BetInput } from '../../src/application/wagering/prepare-bet.js';
import { ProcessWagerTransaction } from '../../src/application/wagering/process-wager-transaction.js';
import { sequenceIds } from './wallet-creation-support.js';

export const betTime = new Date('2026-10-23T16:00:00.123Z');
export function processor(unit: FinancialUnitOfWork, prefix = 'bet'): ProcessWagerTransaction {
  return new ProcessWagerTransaction(unit, sequenceIds(prefix), { now: () => new Date(betTime) });
}
export function betInput(walletId: string, patch: Partial<BetInput> = {}): BetInput {
  return { providerId: 'provider-a', externalTransactionId: 'external-1', idempotencyKey: 'key-1',
    playerId: 'player', walletId, roundId: 'round', gameId: 'game', kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' }, ...patch };
}
/** Stable SQL snapshots include the opening; useful to prove absolutely no partial effects. */
export async function databaseState(sql: SQL): Promise<unknown> {
  const [state] = await sql`SELECT
    (SELECT jsonb_agg(to_jsonb(w) || jsonb_build_object('balance',w.balance::text) ORDER BY id) FROM wallets w) AS wallets,
    (SELECT jsonb_agg(to_jsonb(t) || jsonb_build_object('amount',t.amount::text) ORDER BY id) FROM wager_transactions t) AS transactions,
    (SELECT jsonb_agg(to_jsonb(l) || jsonb_build_object('amount',l.amount::text,
      'balance_before',l.balance_before::text,'balance_after',l.balance_after::text) ORDER BY id) FROM wallet_ledger_entries l) AS ledger,
    (SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM outbox_messages o) AS outbox,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY transaction_id) FROM wager_transaction_results r) AS results,
    (SELECT count(*)::text FROM inbox_messages) AS inbox`;
  return state;
}
