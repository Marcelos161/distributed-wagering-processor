import { correlation, record, count } from './application/observability.js';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { ApiExceptionFilter } from './infrastructure/http/api-errors.js';
import { ConsoleLogger, type INestApplication, type NestApplicationOptions } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

export async function createApplication(options: NestApplicationOptions = {}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, {
    logger: new ConsoleLogger({ json: true }),
    ...options,
    abortOnError: false,
  });
  app.useGlobalFilters(new ApiExceptionFilter());
  app.use((req: { headers: Record<string, unknown>; correlationId?: string }, res: { statusCode: number; on(event: string, callback: () => void): void; setHeader(k: string,v: string): void }, next: () => void) => {
    const header = req.headers['x-correlation-id'];
    req.correlationId = typeof header === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(header) ? header : randomUUID();
    res.setHeader('x-correlation-id', req.correlationId);
    const started = performance.now(), id = req.correlationId;
    res.on('finish', () => { count('http_' + res.statusCode); record('http', { correlationId: id, status: String(res.statusCode), durationMs: performance.now()-started }); });
    correlation.run(id, next);
  });
  return app;
}
