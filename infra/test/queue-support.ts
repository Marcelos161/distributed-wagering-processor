import { CreateQueueCommand, DeleteQueueCommand, GetQueueAttributesCommand, SetQueueAttributesCommand, SendMessageCommand, ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { sqsClient } from '../../src/infrastructure/messaging/sqs-connection.js';
export async function withQueues(run: (queues: { client: SQSClient; source: string; name: string; dlq: string }) => Promise<void>): Promise<void> {
  const client = sqsClient(), name = `dwp-test-${crypto.randomUUID()}.fifo`, dlqName = `dwp-test-dlq-${crypto.randomUUID()}.fifo`;
  let source: string | undefined, dlq: string | undefined;
  try {
    dlq = (await client.send(new CreateQueueCommand({ QueueName: dlqName, Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' } }))).QueueUrl!;
    const arn = (await client.send(new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }))).Attributes!['QueueArn']!;
    source = (await client.send(new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', VisibilityTimeout: '1', RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: '5' }) } }))).QueueUrl!;
    await client.send(new SetQueueAttributesCommand({ QueueUrl: dlq, Attributes: { RedriveAllowPolicy: JSON.stringify({ redrivePermission: 'allowAll' }) } }));
    await run({ client, source, name, dlq });
  } finally {
    for (const url of [source, dlq]) if (url) await client.send(new DeleteQueueCommand({ QueueUrl: url }));
    client.destroy();
  }
}
export async function send(client: SQSClient, url: string, body: unknown, group = crypto.randomUUID()): Promise<void> {
  await client.send(new SendMessageCommand({ QueueUrl: url, MessageGroupId: group, MessageDeduplicationId: crypto.randomUUID(), MessageBody: JSON.stringify(body) }));
}
export async function receive(client: SQSClient, url: string) {
  return (await client.send(new ReceiveMessageCommand({ QueueUrl: url, WaitTimeSeconds: 1, VisibilityTimeout: 1, MaxNumberOfMessages: 10 }))).Messages ?? [];
}
