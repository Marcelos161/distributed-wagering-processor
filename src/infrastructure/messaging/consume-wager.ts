import { createHash } from 'node:crypto';
import { ReceiveMessageCommand, DeleteMessageCommand, ChangeMessageVisibilityCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { FinancialUnitOfWork } from '../../application/ports/financial-persistence.js';
import type { ProcessWagerTransaction } from '../../application/wagering/process-wager-transaction.js';
import { prepareWager } from '../../application/wagering/prepare-wager.js';
import type { Clock } from '../../application/ports/runtime.js';
import { objectFields, token, wagerInput } from '../http/transport-validation.js';
import { queueUrl } from './sqs-connection.js';

export interface ConsumerOptions { queueName: string; consumerName: string; visibilitySeconds: number; waitSeconds: number; retrySeconds: number; }
export class ConsumeWager {
  constructor(private readonly unit: FinancialUnitOfWork, private readonly process: ProcessWagerTransaction,
    private readonly clock: Clock, private readonly client: SQSClient, private readonly options: ConsumerOptions) {}
  async runOne(): Promise<boolean> {
    const url = await queueUrl(this.client, this.options.queueName);
    const message = (await this.client.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 1,
      WaitTimeSeconds: this.options.waitSeconds, VisibilityTimeout: this.options.visibilitySeconds,
      MessageSystemAttributeNames: ['ApproximateReceiveCount'] }))).Messages?.[0];
    if (!message) return false;
    if (!message.ReceiptHandle) throw new Error('Missing receipt handle');
    // Extend visibility while SQL is running. Correctness still comes from Inbox and business identities.
    let extending = Promise.resolve();
    const heartbeat = setInterval(() => {
      extending = extending.then(async () => { await this.client.send(new ChangeMessageVisibilityCommand({ QueueUrl: url,
        ReceiptHandle: message.ReceiptHandle!, VisibilityTimeout: this.options.visibilitySeconds })); }).catch(() => {});
    }, Math.max(250, this.options.visibilitySeconds * 500));
    try {
      if (!message.Body || Buffer.byteLength(message.Body) > 65536) throw new Error('Invalid message body');
      const envelope = objectFields(JSON.parse(message.Body) as unknown, ['messageId','type','occurredAt','data']);
      const messageId = token(envelope.messageId);
      if (envelope.type !== 'WagerTransactionRequested' || typeof envelope.occurredAt !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(envelope.occurredAt) || !Number.isFinite(Date.parse(envelope.occurredAt))) throw new Error('Invalid envelope');
      const data = objectFields(envelope.data, ['providerId','externalTransactionId','idempotencyKey','playerId','walletId','roundId','gameId','kind','money','referenceExternalTransactionId'],
        ['providerId','externalTransactionId','idempotencyKey','playerId','walletId','roundId','gameId','kind','money']);
      const input = wagerInput(data, data.idempotencyKey, 'sqs');
      const hash = createHash('sha256').update(JSON.stringify({ type: envelope.type, key: input.idempotencyKey, business: prepareWager(input).canonicalPayload })).digest('hex');
      await this.unit.run(async repos => {
        const received = await repos.inbox.receive({ messageId, consumerName: this.options.consumerName, payloadHash: hash, receivedAt: this.clock.now() });
        if (received.disposition === 'processed') return;
        await this.process.processInTransaction(input, repos);
        received.message.markProcessed(this.clock.now()); await repos.inbox.save(received.message);
      });
      clearInterval(heartbeat); await extending;
      // Resolving unit.run includes deferred constraints and COMMIT. No ACK exists inside the callback.
      await this.client.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle }));
      return true;
    } catch (error) {
      clearInterval(heartbeat); await extending;
      const count = Number(message.Attributes?.['ApproximateReceiveCount'] ?? '1');
      await this.client.send(new ChangeMessageVisibilityCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: Math.min(300, this.options.retrySeconds * 2 ** Math.min(count - 1, 8)) })).catch(() => {});
      throw error; // Invalid/conflicting messages also remain unacked: broker redrive policy owns the DLQ.
    } finally { clearInterval(heartbeat); }
  }
  close(): void { this.client.destroy(); }
}
