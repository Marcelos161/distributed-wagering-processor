import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { checkQueue, sqsClient } from '../messaging/sqs-connection.js';
@Controller('health')
export class HealthController {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}
  @Get('live') live(): { status: 'ok' } { return { status: 'ok' }; }
  @Get('ready') async ready(): Promise<{ status: 'ready' }> {
    const client = sqsClient();
    try {
      await Promise.all([this.orm.em.fork().execute('SELECT 1'), checkQueue(client, process.env['SQS_QUEUE_NAME'] ?? 'wager-transactions.fifo')]);
      return { status: 'ready' };
    } catch { throw new ServiceUnavailableException(); }
    finally { client.destroy(); }
  }
}
