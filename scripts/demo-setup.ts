import { SQL } from 'bun';
import { chmod, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { MikroORM } from '@mikro-orm/postgresql';
import { createMigrationOptions } from './migration-options.js';

const root = fileURLToPath(new URL('../', import.meta.url));

async function compose(...args: string[]): Promise<string> {
  const child = Bun.spawn(['docker', 'compose', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [output, , code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code !== 0) throw new Error(`Docker Compose ${args[0]} failed; inspect docker compose ps/logs locally`);
  return output;
}

async function setup(): Promise<void> {
  await compose('up', '-d', '--wait', '--wait-timeout', '120');
  await compose('exec', '-T', 'localstack', 'python3', '/opt/dwp-sqs/provision.py', 'apply');
  const config = JSON.parse(await compose('config', '--format', 'json')) as {
    services: Record<'postgres' | 'localstack', {
      environment: Record<string, string>; ports: Array<{ published: string }>;
    }>;
  };
  const pg = config.services.postgres, sqs = config.services.localstack;
  const name = 'wagering_demo';
  if (pg.environment['POSTGRES_DB'] === name) throw new Error('Demo database must differ from the primary database');
  const admin = new URL(`postgresql://127.0.0.1:${pg.ports[0]!.published}/postgres`);
  admin.username = pg.environment['POSTGRES_USER']!;
  admin.password = pg.environment['POSTGRES_PASSWORD']!;
  const control = new SQL(admin.href, { max: 1, connectionTimeout: 5 });
  try {
    if ((await control`SELECT 1 FROM pg_database WHERE datname=${name}`).length === 0) {
      await control.unsafe('CREATE DATABASE wagering_demo TEMPLATE template0');
    }
  } finally { await control.close(); }
  admin.pathname = `/${name}`;
  const orm = await MikroORM.init(createMigrationOptions(admin.href));
  try { await orm.migrator.up(); } finally { await orm.close(); }
  const app = new URL(admin); app.username = 'wager_app'; app.password = pg.environment['POSTGRES_APP_PASSWORD']!;
  const sql = new SQL(app.href, { max: 1 });
  try { await sql`SELECT id FROM wallets LIMIT 1`; } finally { await sql.close(); }
  const application = [
    'HOST=127.0.0.1', 'PORT=3000', `DATABASE_URL=${app.href}`, 'AWS_ACCESS_KEY_ID=test',
    'AWS_SECRET_ACCESS_KEY=test', 'AWS_EC2_METADATA_DISABLED=true',
    `AWS_REGION=${sqs.environment['AWS_DEFAULT_REGION']}`, `SQS_ENDPOINT=http://127.0.0.1:${sqs.ports[0]!.published}`,
    'SQS_QUEUE_NAME=wager-transactions.fifo', 'SQS_DLQ_NAME=wager-transactions-dlq.fifo',
    'SQS_EVENT_QUEUE_NAME=wager-events.fifo',
  ].join('\n') + '\n';
  for (const [filename, content] of [
    ['.env.demo', application], ['.env.demo-migrations', `MIGRATION_DATABASE_URL=${admin.href}\n`],
  ] as const) {
    await writeFile(root + filename, content, { mode: 0o600 }); await chmod(root + filename, 0o600);
  }
  console.log('Demo ready: wagering_demo migrated; application and migration environments stored separately. Primary database unchanged.');
}

try { await setup(); } catch {
  console.error('Demo setup failed. Check local Docker, database credentials and migration prerequisites; no database was deleted.');
  process.exitCode = 1;
}
