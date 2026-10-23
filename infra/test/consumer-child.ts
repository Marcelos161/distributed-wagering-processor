/** Disposable crash fixture: intercepts the real DeleteMessage boundary, never financial processing. */
import { MikroORM } from '@mikro-orm/postgresql';
import { DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { createOrmOptions } from '../../src/infrastructure/persistence/orm-options.js';
import { MikroFinancialUnitOfWork } from '../../src/infrastructure/persistence/financial/financial-unit-of-work.js';
import { ProcessWagerTransaction } from '../../src/application/wagering/process-wager-transaction.js';
import { SystemClock, UuidGenerator } from '../../src/infrastructure/application/runtime.js';
import { sqsClient } from '../../src/infrastructure/messaging/sqs-connection.js';
import { ConsumeWager } from '../../src/infrastructure/messaging/consume-wager.js';
const url = new URL(process.env['DATABASE_URL']!);
if (!/^\/dwp_test_[a-f0-9]+$/.test(url.pathname) || url.hostname !== '127.0.0.1' || !process.env['SQS_QUEUE_NAME']?.startsWith('dwp-test-')) throw new Error('Disposable only');
const orm = await MikroORM.init(createOrmOptions(url.href)), unit = new MikroFinancialUnitOfWork(orm), clock = new SystemClock(), client = sqsClient();
const transport = new Proxy(client, { get(target, property) {
  if (property === 'send') return async (command: unknown) => {
    if (command instanceof DeleteMessageCommand) { process.stdout.write('COMMITTED_BEFORE_ACK\n'); process.kill(process.pid, 'SIGSTOP'); }
    return Reflect.apply(target.send, target, [command]);
  };
  const value: unknown = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
} });
try { await new ConsumeWager(unit, new ProcessWagerTransaction(unit, new UuidGenerator(), clock), clock, transport,
  { queueName: process.env['SQS_QUEUE_NAME']!, consumerName: 'wager-processor-v1', visibilitySeconds: 1, waitSeconds: 0, retrySeconds: 0 }).runOne(); }
finally { client.destroy(); await orm.close(); }
