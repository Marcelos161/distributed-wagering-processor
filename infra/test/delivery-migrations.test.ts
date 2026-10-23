import { expect, test } from 'bun:test';
import { withOperationalDatabase } from './operational-support.js';
import { creator, fundedInput } from './wallet-creation-support.js';
import { processor, betInput } from './bet-processing-support.js';
import { refundInput } from './refund-support.js';
import { expectSqlState } from './financial-schema-support.js';
import { assertReconciled } from './bet-support.js';

test('all migrations apply from clean database, repeat safely, downgrade empty database and reapply', async () => {
  await withOperationalDatabase(async ({ orm, app }) => {
    expect(await orm.migrator.up()).toEqual([]);
    expect(await orm.migrator.getExecuted()).toHaveLength(10);
    await orm.migrator.down({ to: 0 }); expect(await orm.migrator.getExecuted()).toHaveLength(0);
    await orm.migrator.up(); expect(await orm.migrator.getExecuted()).toHaveLength(10);
    expect((await app`SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user`)[0]).toMatchObject({ rolsuper: false, rolcreatedb: false, rolcreaterole: false });
    await expectSqlState(async () => { await app.unsafe('CREATE TABLE unauthorized(id integer)'); }, '42501');
    await assertReconciled(app);
  });
});
test('terminal ROLLBACK protects downgrade without losing history', async () => {
  await withOperationalDatabase(async ({ orm, unit, app }) => {
    const wallet = await creator(unit).execute(fundedInput), useCase = processor(unit);
    await useCase.execute(betInput(wallet.id)); await useCase.execute(refundInput(wallet.id, { kind: 'ROLLBACK' }));
    await expect(orm.migrator.down({ to: 'Migration20261023000007' })).rejects.toHaveProperty('code','55000');
    expect(await orm.migrator.getExecuted()).toHaveLength(10);
    expect((await app`SELECT balance::text FROM wallets`)[0].balance).toBe('100.00');
    await assertReconciled(app);
  });
});
