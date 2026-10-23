import { metrics, count, record } from '../../application/observability.js';
import { checkQueue, sqsClient } from '../messaging/sqs-connection.js';
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
  let health: ReturnType<typeof Bun.serve> | undefined;
  try {
    await new ApplicationDatabaseCheck(orm).onModuleInit();
    const unit = new MikroFinancialUnitOfWork(orm), clock = new SystemClock();
    task = build({ orm, unit, clock, process: new ProcessWagerTransaction(unit, new UuidGenerator(), clock) });
    const port = Number(process.env['WORKER_HEALTH_PORT'] ?? '0');
    if (!Number.isInteger(port) || port<0 || port>65535) throw new Error('Invalid worker health port');
    health = Bun.serve({ hostname: '127.0.0.1', port, fetch: async request => {
      const path = new URL(request.url).pathname;
      if (path === '/health/live') return Response.json({ status: 'ok', role, stopping });
      if (path === '/metrics') return Response.json({ role, stopping, process: metrics() });
      if (path !== '/health/ready') return new Response(null, { status: 404 });
      const client = sqsClient();
      try {
        if (stopping) return new Response(null, { status: 503 });
        await orm.em.fork().execute('SELECT 1');
        if (role !== 'pending-reference-worker') await checkQueue(client, role === 'outbox-publisher'
          ? process.env['SQS_EVENT_QUEUE_NAME'] ?? 'wager-events.fifo' : process.env['SQS_QUEUE_NAME'] ?? 'wager-transactions.fifo');
        return Response.json({ status: 'ready', role });
      } catch { return Response.json({ status: 'unavailable', role }, { status: 503 }); }
      finally { client.destroy(); }
    } });
    process.stdout.write(JSON.stringify({ role, status: 'started', healthPort: health.port }) + '\n');
    while (!stopping) {
      try { if (!await task.runOne()) await Bun.sleep(250); }
      catch (error) {
        const code = error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]{1,50}$/.test(error.code) ? error.code : 'WORKER_FAILURE';
        count('worker_retries'); record(role, { status: code });
        await Bun.sleep(1000);
      }
    }
  } finally {
    health?.stop(true); task?.close?.(); await orm.close(); process.off('SIGTERM', stop); process.off('SIGINT', stop);
  }
}
