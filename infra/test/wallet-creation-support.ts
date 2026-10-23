import { expect } from 'bun:test';
import type { SQL } from 'bun';
import type { FinancialUnitOfWork } from '../../src/application/ports/financial-persistence.js';
import type { IdGenerator } from '../../src/application/ports/runtime.js';
import { CreateWallet } from '../../src/application/wallet/create-wallet.js';

export const openingTime = '2026-10-23T15:00:00.123Z';
export const fundedInput = { playerId: 'player', initialBalance: { amount: '100.00', currency: 'BRL' } };
export function sequenceIds(prefix = 'case'): IdGenerator {
  let index = 0;
  return { next: () => `${prefix}-${++index}` };
}
export function creator(unit: FinancialUnitOfWork, prefix = 'case'): CreateWallet {
  return new CreateWallet(unit, sequenceIds(prefix), { now: () => new Date(openingTime) });
}
export async function expectCounts(sql: SQL, wallets: string, transactions: string, ledger: string, outbox: string): Promise<void> {
  const [row] = await sql`SELECT
    (SELECT count(*)::text FROM wallets) AS wallets,
    (SELECT count(*)::text FROM wager_transactions) AS transactions,
    (SELECT count(*)::text FROM wallet_ledger_entries) AS ledger,
    (SELECT count(*)::text FROM outbox_messages) AS outbox,
    (SELECT count(*)::text FROM inbox_messages) AS inbox`;
  expect(row).toEqual({ wallets, transactions, ledger, outbox, inbox: '0' });
}
