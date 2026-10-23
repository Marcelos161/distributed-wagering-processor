/** Stops after the real broker confirms SendMessage, before publishedAt. Disposable fixtures only. */
import { MikroORM } from '@mikro-orm/postgresql';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { createOrmOptions } from '../../src/infrastructure/persistence/orm-options.js';
import { sqsClient } from '../../src/infrastructure/messaging/sqs-connection.js';
import { OutboxDispatch } from '../../src/infrastructure/persistence/financial/outbox-dispatch.js';
import { PublishOutbox } from '../../src/infrastructure/messaging/publish-outbox.js';
const url = new URL(process.env['DATABASE_URL']!);
if (url.hostname !== '127.0.0.1' || !/^\/dwp_test_[a-f0-9]+$/.test(url.pathname) || !process.env['SQS_EVENT_QUEUE_NAME']?.startsWith('dwp-test-')) throw new Error('Disposable only');
const orm = await MikroORM.init(createOrmOptions(url.href)), client = sqsClient();
const transport = new Proxy(client, { get(target, property) {
  if (property === 'send') return async (command: unknown) => {
    const result: unknown = await Reflect.apply(target.send, target, [command]);
    if (command instanceof SendMessageCommand) { process.stdout.write('PUBLISHED_BEFORE_MARK\n'); process.kill(process.pid, 'SIGSTOP'); }
    return result;
  };
  const value: unknown = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
} });
try { await new PublishOutbox(new OutboxDispatch(orm, 300), transport, process.env['SQS_EVENT_QUEUE_NAME']!, 'commands.fifo').runOne(); }
finally { client.destroy(); await orm.close(); }
