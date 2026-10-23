/** Test-only child process. No HTTP/SQS consumer; refuses any non-disposable database. */
import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmOptions } from '../../src/infrastructure/persistence/orm-options.js';
import { MikroFinancialUnitOfWork } from '../../src/infrastructure/persistence/financial/financial-unit-of-work.js';
import { ProcessWagerTransaction } from '../../src/application/wagering/process-wager-transaction.js';
import type { BetInput } from '../../src/application/wagering/prepare-bet.js';
import { SystemClock, UuidGenerator } from '../../src/infrastructure/application/runtime.js';

const url = new URL(process.env['DWP_BET_DB']!);
if (url.hostname !== '127.0.0.1' || !/^\/dwp_test_[a-f0-9]+$/.test(url.pathname)) throw new Error('BET worker requires a disposable local database');
const count = Number(process.env['DWP_BET_COUNT']);
if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error('Invalid test operation count');
const input = JSON.parse(process.env['DWP_BET_INPUT']!) as BetInput;
const orm = await MikroORM.init({ ...createOrmOptions(url.href),
  driverOptions: { application_name: url.searchParams.get('application_name') } });
try {
  const useCase = new ProcessWagerTransaction(new MikroFinancialUnitOfWork(orm), new UuidGenerator(), new SystemClock());
  const results = await Promise.all(Array.from({ length: count }, () => useCase.execute(input)));
  process.stdout.write(JSON.stringify({ pid: process.pid, results }));
} finally { await orm.close(); }
