import { SQSClient, GetQueueUrlCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
export function sqsClient(env: Readonly<Record<string, string | undefined>> = process.env): SQSClient {
  return new SQSClient({ endpoint: env['SQS_ENDPOINT'] ?? 'http://127.0.0.1:4566', region: env['AWS_REGION'] ?? 'us-east-1',
    credentials: { accessKeyId: env['AWS_ACCESS_KEY_ID'] ?? 'test', secretAccessKey: env['AWS_SECRET_ACCESS_KEY'] ?? 'test' },
    maxAttempts: 2, requestHandler: { connectionTimeout: 2000, requestTimeout: 15000 } });
}
export async function queueUrl(client: SQSClient, name: string): Promise<string> {
  const result = await client.send(new GetQueueUrlCommand({ QueueName: name }));
  if (!result.QueueUrl) throw new Error('Queue URL missing'); return result.QueueUrl;
}
export async function checkQueue(client: SQSClient, name: string): Promise<void> {
  await client.send(new GetQueueAttributesCommand({ QueueUrl: await queueUrl(client, name), AttributeNames: ['QueueArn'] }));
}
