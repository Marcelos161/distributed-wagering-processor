import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmOptions } from '../persistence/orm-options.js';
import { readDatabaseUrl } from '../persistence/database-url.js';
import { ApplicationDatabaseCheck } from '../persistence/application-database-check.js';
import { MikroFinancialUnitOfWork } from '../persistence/financial/financial-unit-of-work.js';
import { ProcessWagerTransaction } from '../../application/wagering/process-wager-transaction.js';
import { SystemClock, UuidGenerator } from '../application/runtime.js';

export interface WorkerContext {
  orm: MikroORM;
  unit: MikroFinancialUnitOfWork;
  process: ProcessWagerTransaction;
  clock: SystemClock;
}
export interface WorkerTask { runOne(): Promise<boolean>; close?(): void; }
export async function runWorker(role: string, build: (context: WorkerContext) => WorkerTask): Promise<void> {
  const orm = await MikroORM.init({ ...createOrmOptions(readDatabaseUrl(process.env, 'application')),
    driverOptions: { application_name: role, statement_timeout: 30000 } });
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  let task: WorkerTask | undefined;
  try {
    await new ApplicationDatabaseCheck(orm).onModuleInit();
    const unit = new MikroFinancialUnitOfWork(orm), clock = new SystemClock();
    task = build({ orm, unit, clock, process: new ProcessWagerTransaction(unit, new UuidGenerator(), clock) });
    process.stdout.write(JSON.stringify({ role, status: 'started' }) + '\n');
    while (!stopping) {
      try { if (!await task.runOne()) await Bun.sleep(250); }
      catch (error) {
        const code = error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]{1,50}$/.test(error.code) ? error.code : 'WORKER_FAILURE';
        process.stderr.write(JSON.stringify({ role, status: 'retry', code }) + '\n');
        await Bun.sleep(1000);
      }
    }
  } finally {
    task?.close?.(); await orm.close(); process.off('SIGTERM', stop); process.off('SIGINT', stop);
  }
}
