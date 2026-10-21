import { expect, test } from 'bun:test';
import {
  ChangeMessageVisibilityCommand, DeleteMessageCommand, GetQueueAttributesCommand,
  GetQueueUrlCommand, ReceiveMessageCommand, SendMessageCommand,
  SetQueueAttributesCommand, SQSClient, type Message,
} from '@aws-sdk/client-sqs';
import { compose } from './compose.js';

async function sqs(): Promise<SQSClient> {
  const config = JSON.parse(await compose('config', '--format', 'json')) as {
    services: { localstack: { environment: Record<string, string>; ports: Array<{ published: string }> } };
  };
  const service = config.services.localstack;
  return new SQSClient({
    region: service.environment['AWS_DEFAULT_REGION']!,
    endpoint: `http://127.0.0.1:${service.ports[0]?.published}`,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    maxAttempts: 2,
  });
}

async function queues(client: SQSClient): Promise<{ source: string; dlq: string }> {
  const source = await client.send(new GetQueueUrlCommand({ QueueName: 'wager-transactions.fifo' }));
  const dlq = await client.send(new GetQueueUrlCommand({ QueueName: 'wager-transactions-dlq.fifo' }));
  if (!source.QueueUrl || !dlq.QueueUrl) throw new Error('Missing required queue URL');
  return { source: source.QueueUrl, dlq: dlq.QueueUrl };
}

async function attributes(client: SQSClient, url: string): Promise<Record<string, string>> {
  const result = await client.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['All'] }));
  if (!result.Attributes) throw new Error('Missing queue attributes');
  return result.Attributes;
}

async function verifyTopology(client: SQSClient): Promise<void> {
  const urls = await queues(client);
  const source = await attributes(client, urls.source);
  const dlq = await attributes(client, urls.dlq);
  for (const actual of [source, dlq]) {
    expect(actual['FifoQueue']).toBe('true');
    expect(actual['ContentBasedDeduplication']).toBe('false');
    expect(actual['VisibilityTimeout']).toBe('30');
    expect(actual['ReceiveMessageWaitTimeSeconds']).toBe('20');
  }
  expect(source['MessageRetentionPeriod']).toBe('345600');
  expect(dlq['MessageRetentionPeriod']).toBe('1209600');
  const redrive = JSON.parse(source['RedrivePolicy']!);
  expect(redrive.deadLetterTargetArn).toBe(dlq['QueueArn']);
  expect(Number(redrive.maxReceiveCount)).toBe(5);
  expect(JSON.parse(dlq['RedriveAllowPolicy']!)).toEqual({
    redrivePermission: 'byQueue', sourceQueueArns: [source['QueueArn']],
  });
}

async function requireEmpty(client: SQSClient): Promise<void> {
  for (const url of Object.values(await queues(client))) {
    const actual = await attributes(client, url);
    for (const name of ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'ApproximateNumberOfMessagesDelayed']) {
      if (actual[name] !== '0') throw new Error('Infrastructure tests require idle, empty queues; no purge performed');
    }
  }
}

async function sendProbe(client: SQSClient, url: string): Promise<string> {
  const id = crypto.randomUUID();
  const body = JSON.stringify({ type: 'InfrastructureProbe', id });
  await client.send(new SendMessageCommand({
    QueueUrl: url, MessageBody: body, MessageGroupId: `infra-${id}`, MessageDeduplicationId: id,
  }));
  return body;
}

async function receive(client: SQSClient, url: string, wait = 1): Promise<Message | undefined> {
  const response = await client.send(new ReceiveMessageCommand({
    QueueUrl: url, MaxNumberOfMessages: 1, WaitTimeSeconds: wait,
    MessageSystemAttributeNames: ['ApproximateReceiveCount'],
  }));
  return response.Messages?.[0];
}

async function acknowledge(client: SQSClient, url: string, message: Message | undefined, body: string): Promise<void> {
  expect(message?.Body).toBe(body);
  if (!message?.ReceiptHandle) throw new Error('Missing receipt handle');
  await client.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle }));
}

test('SQS provisioning reconciles drift, is repeatable and preserves queued messages', async () => {
  const client = await sqs();
  try {
    await requireEmpty(client);
    await verifyTopology(client);
    const urls = await queues(client);
    const body = await sendProbe(client, urls.source);
    await client.send(new SetQueueAttributesCommand({ QueueUrl: urls.source, Attributes: { VisibilityTimeout: '7' } }));
    try {
      await expect(compose('exec', '-T', 'localstack', 'python3', '/opt/dwp-sqs/provision.py', 'check'))
        .rejects.toThrow('unexpected attribute VisibilityTimeout');
    } finally {
      await compose('exec', '-T', 'localstack', 'python3', '/opt/dwp-sqs/provision.py', 'apply');
    }
    await compose('exec', '-T', 'localstack', 'python3', '/opt/dwp-sqs/provision.py', 'apply');
    await verifyTopology(client);
    expect(await queues(client)).toEqual(urls);
    await acknowledge(client, urls.source, await receive(client, urls.source), body);
    expect(await receive(client, urls.source)).toBeUndefined();
  } finally {
    client.destroy();
  }
}, 30_000);

test('SQS receives, hides, redelivers and deletes a real FIFO message', async () => {
  const client = await sqs();
  try {
    await requireEmpty(client);
    const { source } = await queues(client);
    const body = await sendProbe(client, source);
    const first = await receive(client, source);
    expect(first?.Body).toBe(body);
    expect(first?.Attributes?.['ApproximateReceiveCount']).toBe('1');
    expect(await receive(client, source, 0)).toBeUndefined();
    if (!first?.ReceiptHandle) throw new Error('Missing receipt handle');
    await client.send(new ChangeMessageVisibilityCommand({
      QueueUrl: source, ReceiptHandle: first.ReceiptHandle, VisibilityTimeout: 0,
    }));
    const second = await receive(client, source);
    expect(second?.Attributes?.['ApproximateReceiveCount']).toBe('2');
    await acknowledge(client, source, second, body);
    expect(await receive(client, source)).toBeUndefined();
  } finally {
    client.destroy();
  }
}, 15_000);

test('SQS moves an unacknowledged message to the FIFO DLQ after five deliveries', async () => {
  const client = await sqs();
  try {
    await requireEmpty(client);
    const { source, dlq } = await queues(client);
    const body = await sendProbe(client, source);
    for (let attempt = 1; attempt <= 5; attempt++) {
      const message = await receive(client, source);
      expect(message?.Body).toBe(body);
      expect(Number(message?.Attributes?.['ApproximateReceiveCount'])).toBe(attempt);
      if (!message?.ReceiptHandle) throw new Error('Missing receipt handle');
      await client.send(new ChangeMessageVisibilityCommand({
        QueueUrl: source, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 0,
      }));
    }
    expect(await receive(client, source)).toBeUndefined();
    await acknowledge(client, dlq, await receive(client, dlq, 5), body);
    expect(await receive(client, dlq)).toBeUndefined();
  } finally {
    client.destroy();
  }
}, 20_000);

test('LocalStack restores topology and messaging after restart and recreation', async () => {
  const client = await sqs();
  try {
    await requireEmpty(client);
    const before = await queues(client);
    await compose('restart', 'localstack');
    await compose('up', '-d', '--wait', '--wait-timeout', '90', 'localstack');
    await verifyTopology(client);
    expect(await queues(client)).toEqual(before);
    const firstBody = await sendProbe(client, before.source);
    await acknowledge(client, before.source, await receive(client, before.source), firstBody);

    await compose('up', '-d', '--force-recreate', '--wait', '--wait-timeout', '90', 'localstack');
    await verifyTopology(client);
    expect(await queues(client)).toEqual(before);
    const secondBody = await sendProbe(client, before.source);
    await acknowledge(client, before.source, await receive(client, before.source), secondBody);
    await requireEmpty(client);
  } finally {
    client.destroy();
  }
}, 120_000);
