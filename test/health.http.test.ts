import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { createApplication } from '../src/create-application.js';

describe('HTTP application under Bun', () => {
  let app: INestApplication | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    app = await createApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  test('serves public liveness as JSON through a real HTTP socket', async () => {
    const response = await fetch(`${baseUrl}/health/live`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  test('checks PostgreSQL and SQS readiness through HTTP', async () => {
    const response = await fetch(`${baseUrl}/health/ready`);
    expect(response.status).toBe(200);
    await response.text();
  });
});
