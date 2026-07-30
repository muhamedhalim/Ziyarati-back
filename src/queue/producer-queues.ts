import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';

import {
  bullPrefix,
  DLQ_QUEUES,
  QueueName,
  defaultJobOptions,
} from './queue.constants';
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
 * LAZY per-queue connections (gap-closure pass — see
 * docs/CACHING_QUEUES_AUDIT.md §0.8.7): a `Queue` instance — and the ioredis
 * socket it opens — is created the FIRST TIME a given queue name is actually
 * requested, not eagerly for all 25 at construction. This was chosen over a
 * static per-role queue allow-list (considered and rejected in §0.8.7): the
 * producer side isn't the consume side — e.g. the `critical` role's
 * `CampaignFanoutProcessor` produces onto `campaigns.processRecipient`, a
 * queue `critical` never consumes — so chain-forward enqueues, DLQ parks and
 * retries mean nearly every role's real producer need is close to the full
 * queue set, and a hand-authored map risks silently missing a real call path.
 * Lazy sizing is provably correct (opens exactly what's used, nothing more,
 * nothing less) and needs no maintenance as queues are added. A `dispatch`
 * role deployment, which only ever produces onto 1-2 queues, is the one that
 * benefits most; `critical`/`all`/the API root end up opening close to the
 * same connections they always did, just on first use instead of at boot.
 *
 * Built by a runtime factory (ConfigService injected), so REDIS_URL resolution
 * happens after ConfigModule has loaded — no decoration-time `process.env`
 * pitfall. Lives in the @Global QueueModule, so the API enqueues through these
 * and the worker's fan-out does too. Connections are closed on shutdown.
 */
@Injectable()
export class ProducerQueues implements OnModuleDestroy {
  private readonly logger = new Logger('ProducerQueues');
  private readonly connection: ReturnType<typeof producerConnectionOptions>;
  private readonly defaults: ReturnType<typeof defaultJobOptions>;
  /** Same defaults, minus a retry policy that no consumer ever exercises (L2). */
  private readonly dlqDefaults: ReturnType<typeof defaultJobOptions>;
  private readonly queues = new Map<QueueName, Queue>();

  constructor(config: ConfigService) {
    this.connection = producerConnectionOptions(config);
    this.defaults = defaultJobOptions(config);
    this.dlqDefaults = { ...this.defaults, attempts: 1 };
  }

  /** Returns the queue's producer connection, opening it on first use. */
  get(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, {
        connection: this.connection,
        defaultJobOptions: DLQ_QUEUES.includes(name)
          ? this.dlqDefaults
          : this.defaults,
        prefix: bullPrefix(),
      });
      this.queues.set(name, q);
      this.logger.log(
        `Opened producer connection for queue "${name}" (${this.queues.size} open so far) [producer profile]`,
      );
    }
    return q;
  }

  /**
   * A `Record`-shaped view for callers (`QueueService`) that index by queue
   * name — backed by a `Proxy` so indexing still lazily opens on first use
   * rather than requiring every caller to switch to `.get(name)`.
   */
  record(): Record<QueueName, Queue> {
    return new Proxy({} as Record<QueueName, Queue>, {
      get: (_target, prop) =>
        typeof prop === 'string' ? this.get(prop as QueueName) : undefined,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(
      Array.from(this.queues.values()).map((q) =>
        q.close().catch(() => undefined),
      ),
    );
  }
}
