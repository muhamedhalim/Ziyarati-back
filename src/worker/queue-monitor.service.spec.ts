import { ConfigService } from '@nestjs/config';

import { QueueMonitorService } from './queue-monitor.service';
import { QueueService } from '../queue/queue.service';
import { ALL_QUEUES, QUEUE } from '../queue/queue.constants';

type Handler = (...args: unknown[]) => void;

class FakeQueueEvents {
  static instances: FakeQueueEvents[] = [];
  handlers = new Map<string, Handler>();
  constructor(public readonly name: string, public readonly opts: unknown) {
    FakeQueueEvents.instances.push(this);
  }
  on(event: string, handler: Handler) {
    this.handlers.set(event, handler);
    return this;
  }
  emit(event: string, payload: unknown) {
    this.handlers.get(event)?.(payload);
  }
  async close() {
    return undefined;
  }
}

jest.mock('bullmq', () => ({
  QueueEvents: jest.fn((name: string, opts: unknown) => new FakeQueueEvents(name, opts)),
}));

describe('QueueMonitorService', () => {
  let service: QueueMonitorService;
  let config: ConfigService;
  let queue: { dlqDepth: jest.Mock };
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    FakeQueueEvents.instances = [];
    delete process.env.QUEUE_LOG_COMPLETED;
    config = {
      get: (k: string, d?: unknown) => (k === 'REDIS_URL' ? 'redis://localhost:6379' : d),
    } as unknown as ConfigService;
    queue = { dlqDepth: jest.fn().mockResolvedValue(0) };
    service = new QueueMonitorService(config, queue as unknown as QueueService);

    // Silence + capture NestJS Logger output for assertions without noisy console output.
    const nestCommon = require('@nestjs/common');
    logSpy = jest.spyOn(nestCommon.Logger.prototype, 'log').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(nestCommon.Logger.prototype, 'error').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(nestCommon.Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.restoreAllMocks();
    delete process.env.QUEUE_LOG_COMPLETED;
  });

  it('creates one QueueEvents per queue (all 25 — see queue.constants.ts)', () => {
    service.onModuleInit();
    expect(FakeQueueEvents.instances).toHaveLength(ALL_QUEUES.length);
  });

  it('does NOT log a `completed` event by default', () => {
    service.onModuleInit();
    const qe = FakeQueueEvents.instances[0];
    expect(qe.handlers.has('completed')).toBe(false);
  });

  it('logs `completed` events when QUEUE_LOG_COMPLETED=true', () => {
    process.env.QUEUE_LOG_COMPLETED = 'true';
    service = new QueueMonitorService(config, queue as unknown as QueueService);
    service.onModuleInit();
    const qe = FakeQueueEvents.instances[0];
    expect(qe.handlers.has('completed')).toBe(true);
    qe.emit('completed', { jobId: 'j1' });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('completed job=j1'));
  });

  it('always logs `failed` and `stalled` events, regardless of QUEUE_LOG_COMPLETED', () => {
    service.onModuleInit();
    const qe = FakeQueueEvents.instances[0];
    qe.emit('failed', { jobId: 'j1', failedReason: 'boom' });
    qe.emit('stalled', { jobId: 'j2' });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('failed job=j1: boom'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('stalled job=j2'));
  });

  describe('DLQ depth polling', () => {
    it('polls all FOUR DLQs (not just two — see queue.constants.ts for the corrected count)', async () => {
      jest.useFakeTimers();
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(30_000);

      const polled = queue.dlqDepth.mock.calls.map((c) => c[0]);
      expect(polled).toEqual(
        expect.arrayContaining([
          QUEUE.NOTIFICATIONS_DLQ,
          QUEUE.WHATSAPP_DLQ,
          QUEUE.CAMPAIGNS_DLQ,
          QUEUE.WEBHOOKS_DLQ,
        ]),
      );
      expect(polled).toHaveLength(4);
      jest.useRealTimers();
    });

    it('warns above the depth threshold', async () => {
      jest.useFakeTimers();
      queue.dlqDepth.mockResolvedValue(200);
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(30_000);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('ALERT'));
      jest.useRealTimers();
    });
  });

  it('closes every QueueEvents connection on destroy', () => {
    service.onModuleInit();
    const closeSpies = FakeQueueEvents.instances.map((qe) => jest.spyOn(qe, 'close'));
    service.onModuleDestroy();
    for (const spy of closeSpies) expect(spy).toHaveBeenCalled();
  });
});
