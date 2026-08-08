import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { QueueService } from '../../queue/queue.service';
import { createMockDataSource, MockDataSource } from '../../../test/utils/mock-factories';

import { SupportJobsService } from './support-jobs.service';
import {
  SUPPORT_VISIBLE_QUEUES,
  SUPPORT_WORKER_HEARTBEAT_KEY,
} from './platform-support.constants';

describe('SupportJobsService', () => {
  let service: SupportJobsService;
  let queues: { redisPing: jest.Mock; kvGet: jest.Mock; queueCounts: jest.Mock };
  let dataSource: MockDataSource;

  beforeEach(async () => {
    queues = {
      redisPing: jest.fn().mockResolvedValue(3),
      kvGet: jest.fn().mockResolvedValue(JSON.stringify({ at: new Date().toISOString() })),
      queueCounts: jest.fn().mockResolvedValue({
        email: { waiting: 2, active: 1, delayed: 0, completed: 900, failed: 4 },
        notifications: { waiting: 0, active: 0, delayed: 3, completed: 10, failed: 0 },
        whatsapp: { waiting: 0, active: 0, delayed: 0, completed: 5, failed: 0 },
        // A queue Support must NOT see, even though BullMQ reports it.
        'campaigns-dlq': { waiting: 99, active: 0, delayed: 0, completed: 0, failed: 99 },
      }),
    };
    dataSource = createMockDataSource();
    dataSource.query.mockResolvedValue([{ age: 120 }]);

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SupportJobsService,
        { provide: QueueService, useValue: queues },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = moduleRef.get(SupportJobsService);
  });

  it('returns health only — no Redis keys, no connection string, no job payloads', async () => {
    const result = await service.health();

    expect(Object.keys(result).sort()).toEqual(
      ['collectedAt', 'email', 'queues', 'redis', 'worker'].sort(),
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('redis://');
    expect(serialized).not.toContain(SUPPORT_WORKER_HEARTBEAT_KEY);
    expect(serialized).not.toContain('bull:');
  });

  it('shows only the allow-listed queues — a queue BullMQ reports but Support has no need for stays hidden', async () => {
    const { queues: rows } = await service.health();

    expect(rows.map((q) => q.name)).toEqual([...SUPPORT_VISIBLE_QUEUES]);
    expect(JSON.stringify(rows)).not.toContain('campaigns-dlq');
  });

  it('reports waiting/active/delayed/failed depth, and omits completed (a retention artefact)', async () => {
    const { queues: rows } = await service.health();
    const email = rows.find((q) => q.name === 'email')!;

    expect(email).toEqual({
      name: 'email',
      available: true,
      waiting: 2,
      active: 1,
      delayed: 0,
      failed: 4,
    });
    expect(email).not.toHaveProperty('completed');
  });

  it('marks queues unavailable rather than reporting a misleading zero when the backend is unreachable', async () => {
    queues.queueCounts.mockRejectedValue(new Error('ECONNREFUSED'));

    const { queues: rows } = await service.health();

    for (const row of rows) {
      expect(row.available).toBe(false);
      expect(row.waiting).toBeNull();
      expect(row.failed).toBeNull();
    }
  });

  it('reports redis down without disclosing where it lives', async () => {
    queues.redisPing.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:6379'));

    const { redis } = await service.health();

    expect(redis).toEqual({ status: 'down', latencyMs: null });
    expect(JSON.stringify(redis)).not.toContain('6379');
  });

  it('reports the worker running on a fresh heartbeat', async () => {
    const { worker } = await service.health();

    expect(worker.state).toBe('running');
    expect(worker.heartbeatAgeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('reports degraded on a stale heartbeat', async () => {
    queues.kvGet.mockResolvedValue(
      JSON.stringify({ at: new Date(Date.now() - 7200_000).toISOString() }),
    );

    const { worker } = await service.health();

    expect(worker.state).toBe('degraded');
    expect(worker.heartbeatAgeSeconds).toBeGreaterThan(3600);
  });

  it('reports unknown — not offline — when no heartbeat exists at all, so a fresh deploy is not misread as an incident', async () => {
    queues.kvGet.mockResolvedValue(null);

    const { worker } = await service.health();

    expect(worker.state).toBe('unknown');
    expect(worker.heartbeatAgeSeconds).toBeNull();
  });

  it('degrades gracefully on an unparseable heartbeat rather than throwing the whole health view away', async () => {
    queues.kvGet.mockResolvedValue('not json');

    const { worker } = await service.health();

    expect(worker.state).toBe('unknown');
  });

  it('surfaces the oldest still-QUEUED email as the signal that a worker is not consuming', async () => {
    const { email } = await service.health();

    expect(email.oldestPendingSeconds).toBe(120);
    const [sql] = dataSource.query.mock.calls[0];
    expect(sql).toContain("status = 'QUEUED'");
  });

  it('returns null (not zero) when nothing is pending', async () => {
    dataSource.query.mockResolvedValue([{ age: null }]);

    const { email } = await service.health();

    expect(email.oldestPendingSeconds).toBeNull();
  });

  it('exposes no mutation surface — the service has read methods only', () => {
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(service)).filter(
      (m) => m !== 'constructor',
    );
    for (const method of methods) {
      expect(method).not.toMatch(/pause|resume|drain|clean|remove|delete|retry|purge/i);
    }
  });
});
