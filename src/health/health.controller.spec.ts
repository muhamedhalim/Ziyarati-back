import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  HealthController,
  ReadinessDbClientFactory,
} from './health.controller';
import { QueueService } from '../queue/queue.service';
import { DataSource } from 'typeorm';
import { SchemaGuardRegistry } from '../config/schema-guard.registry';

describe('HealthController', () => {
  let controller: HealthController;
  let queues: { redisPing: jest.Mock; queueCounts: jest.Mock };
  let dataSource: { driver: { master: { waitingCount: number } } };
  let schemaGuards: SchemaGuardRegistry;
  let config: { get: jest.Mock };
  let readinessClient: {
    connect: jest.Mock;
    query: jest.Mock;
    end: jest.Mock;
    on: jest.Mock;
  };
  let createReadinessClient: jest.Mock;

  /** A fresh, successfully-connectable fake `pg.Client` — the common case. */
  function freshReadinessClient() {
    return {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
      end: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    };
  }

  beforeEach(() => {
    queues = { redisPing: jest.fn(), queueCounts: jest.fn() };
    dataSource = { driver: { master: { waitingCount: 0 } } };
    schemaGuards = new SchemaGuardRegistry();
    // Defaults to the same off-by-default value Joi gives
    // SCHEMA_GUARD_FAIL_READINESS in production — a test that forgets to
    // stub this must still exercise the common case, not silently 503.
    config = { get: jest.fn().mockReturnValue('false') };
    readinessClient = freshReadinessClient();
    createReadinessClient = jest.fn(() => readinessClient);
    controller = new HealthController(
      queues as unknown as QueueService,
      dataSource as unknown as DataSource,
      schemaGuards,
      config as unknown as ConfigService,
      createReadinessClient as unknown as ReadinessDbClientFactory,
    );
  });

  afterEach(() => jest.useRealTimers());

  it('liveness always returns ok with no dependency checks', () => {
    const res = controller.liveness();
    expect(res.status).toBe('ok');
    expect(createReadinessClient).not.toHaveBeenCalled();
    expect(queues.redisPing).not.toHaveBeenCalled();
  });

  describe('readiness', () => {
    it('returns ok with DB + Redis status when both are reachable', async () => {
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
      queues.redisPing.mockResolvedValueOnce(5);

      const res = await controller.readiness();

      expect(res).not.toHaveProperty('queues');
      expect(queues.queueCounts).not.toHaveBeenCalled();
    });

    it('returns 503 when the DB is down but Redis is up', async () => {
      readinessClient.connect.mockRejectedValueOnce(
        new Error('connection refused'),
      );
      queues.redisPing.mockResolvedValueOnce(5);

      await expect(controller.readiness()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('returns 503 when Redis is down but the DB is up', async () => {
      queues.redisPing.mockRejectedValueOnce(new Error('redis down'));

      await expect(controller.readiness()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('answers within the fixed timeout instead of hanging when Redis is slow/unresponsive (Phase 0 — see original audit M6/C2)', async () => {
      jest.useFakeTimers();
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

    // ── P0.4 P04-003 / P0.5 ─────────────────────────────────────────────
    // The raw driver messages P0.4 measured against `pg` directly
    // (`connect ECONNREFUSED 127.0.0.1:5999`, `password authentication
    // failed for user "postgres"`, `database "no_such_db" does not exist`)
    // must never reach this @Public() route's body, regardless of what any
    // downstream exception filter does with the thrown response object.
    it('never surfaces the underlying DB driver error message on failure', async () => {
      readinessClient.connect.mockRejectedValueOnce(
        new Error('connect ECONNREFUSED 127.0.0.1:5999'),
      );
      queues.redisPing.mockResolvedValueOnce(5);

      await expect(controller.readiness()).rejects.toMatchObject({
        response: expect.objectContaining({
          database: { status: 'down', error: 'unreachable' },
        }),
      });
    });

    it('never surfaces the underlying Redis driver error message on failure', async () => {
      queues.redisPing.mockRejectedValueOnce(
        new Error('password authentication failed for user "postgres"'),
      );

      await expect(controller.readiness()).rejects.toMatchObject({
        response: expect.objectContaining({
          redis: { status: 'down', error: 'unreachable' },
        }),
      });
    });

    // ── P0.5 ─────────────────────────────────────────────────────────────
    it('reads SCHEMA_GUARD_FAIL_READINESS via ConfigService, not process.env directly', async () => {
      queues.redisPing.mockResolvedValueOnce(5);
      jest.spyOn(schemaGuards, 'summary').mockReturnValue({
        status: 'degraded',
        requiredChecked: 43,
        requiredFailed: 1,
      });
      config.get.mockReturnValue('true');

      await expect(controller.readiness()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(config.get).toHaveBeenCalledWith('SCHEMA_GUARD_FAIL_READINESS');
    });

    it('stays HTTP 200 degraded (not 503) when SCHEMA_GUARD_FAIL_READINESS is false and a guard is missing', async () => {
      queues.redisPing.mockResolvedValueOnce(5);
      jest.spyOn(schemaGuards, 'summary').mockReturnValue({
        status: 'degraded',
        requiredChecked: 43,
        requiredFailed: 1,
      });
      config.get.mockReturnValue('false');

      const res = await controller.readiness();
      expect(res.status).toBe('degraded');
    });

    // ── P1.4 (MS-009) ────────────────────────────────────────────────────
    describe('dedicated DB connection (never the shared pool)', () => {
      it('connects once and REUSES the same client across multiple readiness calls', async () => {
        queues.redisPing.mockResolvedValue(5);

        await controller.readiness();
        await controller.readiness();
        await controller.readiness();

        expect(createReadinessClient).toHaveBeenCalledTimes(1);
        expect(readinessClient.connect).toHaveBeenCalledTimes(1);
        expect(readinessClient.query).toHaveBeenCalledTimes(3);
      });

      it('two concurrent readiness calls share ONE in-flight connect attempt', async () => {
        queues.redisPing.mockResolvedValue(5);
        let resolveConnect!: () => void;
        readinessClient.connect.mockReturnValueOnce(
          new Promise<void>((resolve) => {
            resolveConnect = resolve;
          }),
        );

        const first = controller.readiness();
        const second = controller.readiness();
        resolveConnect();
        await Promise.all([first, second]);

        expect(createReadinessClient).toHaveBeenCalledTimes(1);
        expect(readinessClient.connect).toHaveBeenCalledTimes(1);
      });

      it('reconnects with a fresh client after a query failure, rather than reusing a dead one', async () => {
        queues.redisPing.mockResolvedValue(5);
        readinessClient.query.mockRejectedValueOnce(
          new Error('connection terminated unexpectedly'),
        );
        const secondClient = freshReadinessClient();
        createReadinessClient
          .mockReturnValueOnce(readinessClient)
          .mockReturnValueOnce(secondClient);

        await expect(controller.readiness()).rejects.toBeInstanceOf(
          ServiceUnavailableException,
        );
        // The broken client is discarded — verified by its `end()` being
        // called — so the NEXT probe reconnects instead of reusing it.
        expect(readinessClient.end).toHaveBeenCalledTimes(1);

        const res = await controller.readiness();
        expect(res.status).toBe('ok');
        expect(createReadinessClient).toHaveBeenCalledTimes(2);
      });

      it('a query failure never leaks the underlying driver message, matching the connect-failure case', async () => {
        queues.redisPing.mockResolvedValue(5);
        readinessClient.query.mockRejectedValueOnce(
          new Error('database "no_such_db" does not exist'),
        );

        await expect(controller.readiness()).rejects.toMatchObject({
          response: expect.objectContaining({
            database: { status: 'down', error: 'unreachable' },
          }),
        });
      });
    });

    describe('pool-saturation status ("busy" — MS-009)', () => {
      it('stays HTTP 200 with status "busy" when the pool has waiting callers but the DB itself is reachable', async () => {
        dataSource.driver.master.waitingCount = 4;
        queues.redisPing.mockResolvedValueOnce(5);

        const res = await controller.readiness();

        expect(res.status).toBe('busy');
        expect(res.database).toEqual({ status: 'up', poolWaiting: 4 });
      });

      it('omits poolWaiting entirely when there is no queueing', async () => {
        dataSource.driver.master.waitingCount = 0;
        queues.redisPing.mockResolvedValueOnce(5);

        const res = await controller.readiness();

        expect(res.database).toEqual({ status: 'up' });
        expect(res.database).not.toHaveProperty('poolWaiting');
      });

      it('a missing schema guard reports "degraded", not "busy", even when the pool is also saturated — degraded takes priority', async () => {
        dataSource.driver.master.waitingCount = 4;
        queues.redisPing.mockResolvedValueOnce(5);
        jest.spyOn(schemaGuards, 'summary').mockReturnValue({
          status: 'degraded',
          requiredChecked: 43,
          requiredFailed: 1,
        });

        const res = await controller.readiness();

        expect(res.status).toBe('degraded');
        // The pool signal is still visible even though it didn't win the
        // top-level status — nothing is hidden, just prioritized.
        expect(res.database).toEqual({ status: 'up', poolWaiting: 4 });
      });

      it('never throws when the driver has no pool shape (e.g. not yet initialized) — reports 0 waiting', async () => {
        const bareDataSource = { driver: {} } as unknown as DataSource;
        const c = new HealthController(
          queues as unknown as QueueService,
          bareDataSource,
          schemaGuards,
          config as unknown as ConfigService,
          createReadinessClient as unknown as ReadinessDbClientFactory,
        );
        queues.redisPing.mockResolvedValueOnce(5);

        const res = await c.readiness();
        expect(res.status).toBe('ok');
        expect(res.database).toEqual({ status: 'up' });
      });
    });

    describe('shutdown (onModuleDestroy)', () => {
      it('closes the dedicated connection if one was ever opened', async () => {
        queues.redisPing.mockResolvedValueOnce(5);
        await controller.readiness(); // opens the connection

        await controller.onModuleDestroy();

        expect(readinessClient.end).toHaveBeenCalledTimes(1);
      });

      it('is a no-op if the connection was never opened', async () => {
        await controller.onModuleDestroy();
        expect(readinessClient.end).not.toHaveBeenCalled();
      });
    });
  });
});
