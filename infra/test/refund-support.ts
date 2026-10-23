import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmOptions } from '../../src/infrastructure/persistence/orm-options.js';
import { MikroFinancialUnitOfWork } from '../../src/infrastructure/persistence/financial/financial-unit-of-work.js';
import { withFinancialDatabase } from './financial-schema-support.js';
import type { BetDatabase } from './bet-support.js';
import type { WagerInput } from '../../src/application/wagering/prepare-wager.js';
import { betInput } from './bet-processing-support.js';

export async function withRefundDatabase(run: (db: BetDatabase) => Promise<void>): Promise<void> {
  await withFinancialDatabase('Migration20261023000007', async db => {
    const appOrm = await MikroORM.init(createOrmOptions(db.applicationUrl));
    try { await run({ ...db, appOrm, unit: new MikroFinancialUnitOfWork(appOrm) }); }
    finally { await appOrm.close(); }
  });
}
export function refundInput(walletId: string, patch: Partial<WagerInput> = {}): WagerInput {
  return { ...betInput(walletId), kind: 'REFUND', externalTransactionId: 'refund', idempotencyKey: 'refund',
    referenceExternalTransactionId: 'external-1', ...patch };
}
