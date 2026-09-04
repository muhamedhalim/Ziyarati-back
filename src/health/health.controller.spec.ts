import { ServiceUnavailableException } from '@nestjs/common';

import { HealthController } from './health.controller';
import { QueueService } from '../queue/queue.service';
import { DataSource } from 'typeorm';
import { SchemaGuardRegistry } from '../config/schema-guard.registry';

describe('HealthController', () => {
  let controller: HealthController;
  let queues: { redisPing: jest.Mock; queueCounts: jest.Mock };
  let dataSource: { query: jest.Mock };
  let schemaGuards: SchemaGuardRegistry;

  beforeEach(() => {
    queues = { redisPing: jest.fn(), queueCounts: jest.fn() };
    dataSource = { query: jest.fn() };
    schemaGuards = new SchemaGuardRegistry();
    controller = new HealthController(
      queues as unknown as QueueService,
      dataSource as unknown as DataSource,
      schemaGuards,
    );
    delete process.env.SCHEMA_GUARD_FAIL_READINESS;
  });

  afterEach(() => jest.useRealTimers());

  it('liveness always returns ok with no dependency checks', () => {
    const res = controller.liveness();
    expect(res.status).toBe('ok');
    expect(dataSource.query).not.toHaveBeenCalled();
    expect(queues.redisPing).not.toHaveBeenCalled();
  });

  describe('readiness', () => {
    it('returns ok with DB + Redis status when both are reachable', async () => {
      dataSource.query.mockResolvedValueOnce([{ '?column?': 1 }]);
      queues.redisPing.mockResolvedValueOnce(5);

      const res = await controller.readiness();

      expect(res).toEqual({
        status: 'ok',
        database: { status: 'up' },
        redis: { status: 'up', latencyMs: 5 },
        // P0.3 SCHEMA-004: counts only, never an object or table name — this
        // route is @Public() and naming a missing uniqueness guard would tell
        // an anonymous caller exactly which duplicate to attempt.
        schemaGuards: { status: 'ok', requiredChecked: 0, requiredFailed: 0 },
      });
    });

    it('never includes per-queue job counts (Phase 0 — see original audit M6: this was a public amplification/disclosure vector)', async () => {
      dataSource.query.mockResolvedValueOnce([{ '?column?': 1 }]);
      queues.redisPing.mockResolvedValueOnce(5);

      const res = await controller.readiness();

      expect(res).not.toHaveProperty('queues');
      expect(queues.queueCounts).not.toHaveBeenCalled();
    });

    it('returns 503 when the DB is down but Redis is up', async () => {
      dataSource.query.mockRejectedValueOnce(new Error('connection refused'));
      queues.redisPing.mockResolvedValueOnce(5);

      await expect(controller.readiness()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('returns 503 when Redis is down but the DB is up', async () => {
      dataSource.query.mockResolvedValueOnce([{ '?column?': 1 }]);
      queues.redisPing.mockRejectedValueOnce(new Error('redis down'));

      await expect(controller.readiness()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('answers within the fixed timeout instead of hanging when Redis is slow/unresponsive (Phase 0 — see original audit M6/C2)', async () => {
      jest.useFakeTimers();
      dataSource.query.mockResolvedValueOnce([{ '?column?': 1 }]);
      // Redis "hangs" far longer than the readiness timeout.
      queues.redisPing.mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve(5), 30_000)),
      );

      const pending = controller.readiness();
      const assertion = expect(pending).rejects.toMatchObject({
        response: expect.objectContaining({
          status: 'degraded',
          redis: expect.objectContaining({ status: 'down' }),
        }),
      });

      // Advance past the 1.5s readiness timeout, but nowhere near the 30s "hang".
      await jest.advanceTimersByTimeAsync(1600);
      await assertion;
      jest.useRealTimers();
    });
  });
});
