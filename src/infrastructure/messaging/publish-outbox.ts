import { createHash } from 'node:crypto';
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { OutboxDispatch } from '../persistence/financial/outbox-dispatch.js';
import { queueUrl } from './sqs-connection.js';
export class PublishOutbox {
  constructor(private readonly dispatch: OutboxDispatch, private readonly client: SQSClient, private readonly eventQueue: string, commandQueue: string) {
    if (eventQueue === commandQueue) throw new Error('Events must not feed the command queue');
  }
  async runOne(): Promise<boolean> {
    const claim = await this.dispatch.claim(); if (!claim) return false;
    try {
      const data = claim.message.payload.data as { walletId: string };
      await this.client.send(new SendMessageCommand({ QueueUrl: await queueUrl(this.client, this.eventQueue),
        MessageBody: JSON.stringify(claim.message.payload), MessageDeduplicationId: claim.message.id,
        MessageGroupId: createHash('sha256').update(data.walletId).digest('hex') }));
    } catch (error) {
      await this.dispatch.finish(claim, false); throw error;
    }
    await this.dispatch.finish(claim, true);
    return true;
  }
  close(): void { this.client.destroy(); }
}
