import { runWorker } from './infrastructure/workers/worker-runtime.js';
import { ConsumeWager } from './infrastructure/messaging/consume-wager.js';
import { sqsClient } from './infrastructure/messaging/sqs-connection.js';
import { positiveInteger } from './infrastructure/config/worker-configuration.js';
await runWorker('wager-consumer', ({ unit, process: processor, clock }) => new ConsumeWager(unit, processor, clock, sqsClient(), {
  queueName: process.env['SQS_QUEUE_NAME'] ?? 'wager-transactions.fifo', consumerName: 'wager-processor-v1',
  visibilitySeconds: positiveInteger(process.env, 'SQS_VISIBILITY_SECONDS', 30, 43200), waitSeconds: 10,
  retrySeconds: positiveInteger(process.env, 'SQS_RETRY_SECONDS', 1, 300),
})).catch(() => { process.stderr.write(JSON.stringify({ role: 'wager-consumer', status: 'startup_failed' }) + '\n'); process.exitCode = 1; });
