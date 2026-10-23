import { runWorker } from './infrastructure/workers/worker-runtime.js';
import { PublishOutbox } from './infrastructure/messaging/publish-outbox.js';
import { OutboxDispatch } from './infrastructure/persistence/financial/outbox-dispatch.js';
import { sqsClient } from './infrastructure/messaging/sqs-connection.js';
import { positiveInteger } from './infrastructure/config/worker-configuration.js';
await runWorker('outbox-publisher', ({ orm }) => new PublishOutbox(new OutboxDispatch(orm,
  positiveInteger(process.env, 'OUTBOX_LEASE_MS', 60000)), sqsClient(), process.env['SQS_EVENT_QUEUE_NAME'] ?? 'wager-events.fifo', process.env['SQS_QUEUE_NAME'] ?? 'wager-transactions.fifo'))
  .catch(() => { process.stderr.write(JSON.stringify({ role: 'outbox-publisher', status: 'startup_failed' }) + '\n'); process.exitCode = 1; });
