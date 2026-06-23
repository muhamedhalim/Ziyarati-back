import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';

import { ALL_QUEUES, QueueName, defaultJobOptions } from './queue.constants';
import { producerConnectionOptions } from './redis.config';

/**
 * Dedicated PRODUCER-side BullMQ `Queue` instances.
 *
 * Why this exists (and why we don't just enqueue through the `@nestjs/bullmq`
 * registered queues): the BullMQ explorer derives each `Worker`'s connection
 * from its queue options. So the registered queues MUST stay on the blocking
 * worker profile (`maxRetriesPerRequest: null`). To give producers their own
 * profile (offline-queue buffering + normal request retries) we build separate
 * `Queue` objects here from `producerConnectionOptions` — each opens its OWN
 * ioredis socket, isolated from the workers' blocking connections and from the
 * QueueEvents connection.
 *
 * Built by a runtime factory (ConfigService injected), so REDIS_URL resolution
 * happens after ConfigModule has loaded — no decoration-time `process.env`
 * pitfall. Lives in the @Global QueueModule, so the API enqueues through these
 * and the worker's fan-out does too. Connections are closed on shutdown.
 */
@Injectable()
export class ProducerQueues implements OnModuleDestroy {
  private readonly logger = new Logger('ProducerQueues');
  private readonly queues: Record<QueueName, Queue>;

  constructor(config: ConfigService) {
    const connection = producerConnectionOptions(config);
    const defaults = defaultJobOptions(config);

    const entries = ALL_QUEUES.map(
      (name) =>
        [name, new Queue(name, { connection, defaultJobOptions: defaults })] as const,
    );
    this.queues = Object.fromEntries(entries) as Record<QueueName, Queue>;
    this.logger.log(
      `Initialized ${ALL_QUEUES.length} producer queue connection(s) [producer profile]`,
    );
  }

  get(name: QueueName): Queue {
    return this.queues[name];
  }

  record(): Record<QueueName, Queue> {
    return this.queues;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(
      Object.values(this.queues).map((q) => q.close().catch(() => undefined)),
    );
  }
}
