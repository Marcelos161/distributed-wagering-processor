import { Controller, Get, Inject } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { metrics } from '../../application/observability.js';
import { sqsClient, queueUrl } from '../messaging/sqs-connection.js';
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}
  @Get() async read() {
    const em = this.orm.em.fork(), client = sqsClient();
    try {
      const [statuses, outbox, pending, locks, workers, dlq] = await Promise.all([
        em.execute('SELECT status,count(*)::text count FROM wager_transactions GROUP BY status'),
        em.execute("SELECT count(*)::text backlog,COALESCE(EXTRACT(EPOCH FROM clock_timestamp()-min(occurred_at)),0)::text lag_seconds FROM outbox_messages WHERE published_at IS NULL"),
        em.execute("SELECT count(*)::text backlog FROM pending_reference_jobs WHERE completed_at IS NULL"),
        em.execute("SELECT count(*)::text waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'"),
        em.execute("SELECT application_name,count(*)::text connections FROM pg_stat_activity WHERE datname=current_database() AND application_name IN ('outbox-publisher','wager-consumer','pending-reference-worker') GROUP BY application_name"),
        queueUrl(client, process.env['SQS_DLQ_NAME'] ?? 'wager-transactions-dlq.fifo').then(url => client.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['ApproximateNumberOfMessages'] }))),
      ]);
      return { process: metrics(), transactions: statuses, outbox, pendingReferences: pending, locks, workers,
        dlqMessages: dlq.Attributes?.['ApproximateNumberOfMessages'] ?? '0' };
    } finally { client.destroy(); }
  }
}
