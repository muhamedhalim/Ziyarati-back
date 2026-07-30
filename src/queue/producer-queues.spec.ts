import { ConfigService } from '@nestjs/config';

import { ProducerQueues } from './producer-queues';
import { QUEUE } from './queue.constants';

class FakeQueue {
  static instances: FakeQueue[] = [];
  constructor(
    public readonly name: string,
    public readonly opts: { defaultJobOptions?: { attempts?: number } },
  ) {
    FakeQueue.instances.push(this);
  }
  async close() {
    return undefined;
  }
}

jest.mock('bullmq', () => ({
  Queue: jest.fn(
    (name: string, opts: unknown) => new FakeQueue(name, opts as never),
  ),
}));

function buildConfig(values: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string, fallback?: unknown) => values[key] ?? fallback,
  } as unknown as ConfigService;
}

describe('ProducerQueues (L2 — DLQ default job options)', () => {
  beforeEach(() => {
    FakeQueue.instances = [];
  });

  const config = buildConfig({ REDIS_URL: 'redis://localhost:6379/0' });

  it('gives an ordinary queue the shared retry policy', () => {
    const producer = new ProducerQueues(config);
    const q = producer.get(QUEUE.NOTIFICATIONS) as unknown as FakeQueue;
    expect(q.opts.defaultJobOptions?.attempts).toBe(5);
  });

  it('zeroes out attempts for every DLQ — no consumer ever processes them (L2)', () => {
    const producer = new ProducerQueues(config);
    const dlqNames = [
      QUEUE.NOTIFICATIONS_DLQ,
      QUEUE.WHATSAPP_DLQ,
      QUEUE.CAMPAIGNS_DLQ,
      QUEUE.WEBHOOKS_DLQ,
    ];
    for (const name of dlqNames) {
      const q = producer.get(name) as unknown as FakeQueue;
      expect(q.opts.defaultJobOptions?.attempts).toBe(1);
    }
  });

  it('reuses the same Queue instance on a second get() for the same name', () => {
    const producer = new ProducerQueues(config);
    const first = producer.get(QUEUE.CAMPAIGNS_DLQ);
    const second = producer.get(QUEUE.CAMPAIGNS_DLQ);
    expect(first).toBe(second);
  });
});
