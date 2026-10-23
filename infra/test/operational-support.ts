import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmOptions } from '../../src/infrastructure/persistence/orm-options.js';
import { MikroFinancialUnitOfWork } from '../../src/infrastructure/persistence/financial/financial-unit-of-work.js';
import { withFinancialDatabase } from './financial-schema-support.js';
import type { BetDatabase } from './bet-support.js';

export async function withOperationalDatabase(run: (db: BetDatabase) => Promise<void>): Promise<void> {
  await withFinancialDatabase('Migration20261023000008', async db => {
    await db.orm.migrator.up();
    const appOrm = await MikroORM.init(createOrmOptions(db.applicationUrl));
    try { await run({ ...db, appOrm, unit: new MikroFinancialUnitOfWork(appOrm) }); }
    finally { await appOrm.close(); }
  });
}
