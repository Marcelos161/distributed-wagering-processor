import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmOptions } from '../../src/infrastructure/persistence/orm-options.js';
import { MikroFinancialUnitOfWork } from '../../src/infrastructure/persistence/financial/financial-unit-of-work.js';
import { withFinancialDatabase } from './financial-schema-support.js';
import type { BetDatabase } from './bet-support.js';

export async function withWagerDatabase(run: (db: BetDatabase) => Promise<void>): Promise<void> {
  await withFinancialDatabase('Migration20261023000006', async db => {
    const appOrm = await MikroORM.init(createOrmOptions(db.applicationUrl));
    try { await run({ ...db, appOrm, unit: new MikroFinancialUnitOfWork(appOrm) }); }
    finally { await appOrm.close(); }
  });
}

import type { WagerInput } from '../../src/application/wagering/prepare-wager.js';
import type { SQL } from 'bun';
import { betInput, databaseState } from './bet-processing-support.js';

export function wagerInput(walletId: string, kind: 'WIN' | 'LOSS' = 'WIN', patch: Partial<WagerInput> = {}): WagerInput {
  return { ...betInput(walletId), kind, money: { amount: kind === 'WIN' ? '40.50' : '0.00', currency: 'BRL' }, ...patch };
}
export async function wagerState(sql: SQL): Promise<unknown> {
  return { financial: await databaseState(sql), pending: await sql`SELECT * FROM wager_pending_receipts ORDER BY transaction_id` };
}
