import { UnrecoverableError } from 'bullmq';

import { JOB } from '../../queue/queue.constants';
import { PlatformProcessor } from './platform.processor';
import { DistributedLockService } from '../../queue/distributed-lock.service';
import { WorkerAuthorizationService } from '../../queue/worker-authorization.service';
import { WaitlistService } from '../../modules/waitlist/waitlist.service';
import { WaitlistOfferService } from '../../modules/waitlist/waitlist-offer.service';
import { PatientQueueService } from '../../modules/patient-queue/patient-queue.service';
import { ReportExportService } from '../../modules/report-export/report-export.service';
import { BirthdayGreetingSweepService } from '../../modules/workflow/birthday-greeting.sweep.service';

describe('PlatformProcessor', () => {
  const build = (lockToken: string | null) => {
    const maintenance = {
      purgeOldLogs: jest.fn().mockResolvedValue(undefined),
    };
    const authTokens = {
      purgeExpiredTokens: jest.fn().mockResolvedValue(undefined),
    };
    const ctx = {
      run: jest.fn((fn: () => unknown) => fn()),
      setPrincipal: jest.fn(),
      setCorrelationId: jest.fn(),
    };
    const authz = { assertAuthorized: jest.fn().mockResolvedValue(undefined) };
    const lock = {
      acquire: jest.fn().mockResolvedValue(lockToken),
      release: jest.fn().mockResolvedValue(undefined),
      renew: jest.fn().mockResolvedValue(true),
    };
    const metrics = { setWorkerHeartbeat: jest.fn() };
    const waitlistEntries = {
      expireDueEntries: jest.fn().mockResolvedValue(2),
    };
    const waitlistOffers = {
      expireDueOffers: jest.fn().mockResolvedValue(3),
      evaluateFreedSlot: jest.fn().mockResolvedValue({ offered: 1 }),
    };
    const patientQueue = {
      closeUnresolvedEntries: jest.fn().mockResolvedValue({ closed: 4 }),
    };
    // Not this task's (T174/US10) concern — mocked only so the shared
    // constructor stays satisfiable now that T183 (US13) added its own
    // `reportExport` param. Its own exportExpiry behaviour is covered by
    // T183's own tests, not here.
    const reportExport = {
      expireDueExports: jest.fn().mockResolvedValue({ expired: 0 }),
    };
    const birthdayGreetings = {
      sweep: jest
        .fn()
        .mockResolvedValue({ tenants: 2, processed: 1, emitted: 3 }),
    };

    const processor = new PlatformProcessor(
      maintenance as any,
      authTokens as any,
      ctx as any,
      authz as unknown as WorkerAuthorizationService,
      lock as unknown as DistributedLockService,
      metrics as any,
      waitlistEntries as unknown as WaitlistService,
      waitlistOffers as unknown as WaitlistOfferService,
      patientQueue as unknown as PatientQueueService,
      reportExport as unknown as ReportExportService,
      birthdayGreetings as unknown as BirthdayGreetingSweepService,
    );
    return {
      processor,
      maintenance,
      authTokens,
      lock,
      metrics,
      waitlistEntries,
      waitlistOffers,
      patientQueue,
      reportExport,
      birthdayGreetings,
      authz,
    };
  };

  describe('birthdayGreetings — lock guard + heartbeat + lock renewal', () => {
    const jobData = { name: JOB.PLATFORM_BIRTHDAY_GREETINGS, data: {} } as any;

    it('acquires the lock, runs the sweep, heartbeats and releases on a COMPLETED run', async () => {
      const { processor, lock, metrics, birthdayGreetings } = build('token-b');

      const result = await processor.process(jobData);

      expect(birthdayGreetings.sweep).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ tenants: 2, processed: 1, emitted: 3 });
      expect(metrics.setWorkerHeartbeat).toHaveBeenCalledWith(
        'platform.birthdayGreetings',
      );
      expect(lock.release).toHaveBeenCalledWith(
        'lock:birthday-greetings',
        'token-b',
      );
    });

    it("hands the sweep a keepAlive that renews THIS run's lock token", async () => {
      const { processor, lock, birthdayGreetings } = build('token-b');
      lock.renew.mockResolvedValueOnce(false);

      await processor.process(jobData);

      const opts = birthdayGreetings.sweep.mock.calls[0][1];
      // Lost lock => the sweep is told to stop, not to carry on unguarded.
      await expect(opts.keepAlive()).resolves.toBe(false);
      expect(lock.renew).toHaveBeenCalledWith(
        'lock:birthday-greetings',
        'token-b',
        expect.any(Number),
      );
    });

    it('M5 — a lock-unavailable run logs a visible skip, runs NO sweep and emits NO heartbeat', async () => {
      const { processor, lock, metrics, birthdayGreetings } = build(null);
      const logSpy = jest.spyOn((processor as any).logger, 'log');

      const result = await processor.process(jobData);

      expect(result).toEqual({ skipped: true });
      expect(birthdayGreetings.sweep).not.toHaveBeenCalled();
      expect(lock.release).not.toHaveBeenCalled();
      expect(metrics.setWorkerHeartbeat).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('skipping this run'),
      );
    });

    it('still releases the lock if the sweep throws', async () => {
      const { processor, lock, metrics, birthdayGreetings } = build('token-x');
      birthdayGreetings.sweep.mockRejectedValueOnce(new Error('db error'));

      await expect(processor.process(jobData)).rejects.toThrow('db error');

      expect(lock.release).toHaveBeenCalledWith(
        'lock:birthday-greetings',
        'token-x',
      );
      expect(metrics.setWorkerHeartbeat).not.toHaveBeenCalled();
    });
  });

  describe('waitlistExpiry — lock guard + heartbeat (T160, M5)', () => {
    it('acquires the lock, expires offers and entries, and heartbeats on a COMPLETED run — even when nothing was due', async () => {
      const { processor, lock, metrics, waitlistEntries, waitlistOffers } =
        build('token-abc');
      waitlistOffers.expireDueOffers.mockResolvedValue(0);
      waitlistEntries.expireDueEntries.mockResolvedValue(0);

      const result = await processor.process({
        name: JOB.PLATFORM_WAITLIST_EXPIRY,
        data: {},
      } as any);

      expect(waitlistOffers.expireDueOffers).toHaveBeenCalled();
      expect(waitlistEntries.expireDueEntries).toHaveBeenCalled();
      expect(result).toEqual({ expiredOffers: 0, expiredEntries: 0 });
      expect(lock.release).toHaveBeenCalledWith(
        'lock:waitlist-expiry',
        'token-abc',
      );
      // The M5 property under test: a healthy-but-idle sweep STILL
      // heartbeats — silence in the heartbeat can then only mean the sweep
      // itself stopped running, never "there was nothing to expire".
      expect(metrics.setWorkerHeartbeat).toHaveBeenCalledWith(
        'platform.waitlistExpiry',
      );
    });

    it('heartbeats with real counts when there is work to do', async () => {
      const { processor, metrics } = build('token-abc');

      const result = await processor.process({
        name: JOB.PLATFORM_WAITLIST_EXPIRY,
        data: {},
      } as any);

      expect(result).toEqual({ expiredOffers: 3, expiredEntries: 2 });
      expect(metrics.setWorkerHeartbeat).toHaveBeenCalledWith(
        'platform.waitlistExpiry',
      );
    });

    it('M5 — a lock-unavailable run logs a visible skip and emits NO heartbeat (indistinguishable-from-Redis-outage case)', async () => {
      const { processor, lock, metrics, waitlistOffers, waitlistEntries } =
        build(null);
      const logSpy = jest.spyOn((processor as any).logger, 'log');

      const result = await processor.process({
        name: JOB.PLATFORM_WAITLIST_EXPIRY,
        data: {},
      } as any);

      expect(waitlistOffers.expireDueOffers).not.toHaveBeenCalled();
      expect(waitlistEntries.expireDueEntries).not.toHaveBeenCalled();
      expect(result).toEqual({ skipped: true });
      expect(lock.release).not.toHaveBeenCalled();
      // The M5 property under test: no heartbeat on a skipped run.
      expect(metrics.setWorkerHeartbeat).not.toHaveBeenCalled();
      // ...but the skip itself is VISIBLE in the logs, so an operator can
      // tell "healthy, nothing to do" apart from "sweep silently stopped".
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('skipping this run'),
      );
    });

    it('still releases the lock if the expiry sweep throws', async () => {
      const { processor, lock, waitlistOffers } = build('token-xyz');
      waitlistOffers.expireDueOffers.mockRejectedValueOnce(
        new Error('db error'),
      );

      await expect(
        processor.process({
          name: JOB.PLATFORM_WAITLIST_EXPIRY,
          data: {},
        } as any),
      ).rejects.toThrow('db error');

      expect(lock.release).toHaveBeenCalledWith(
        'lock:waitlist-expiry',
        'token-xyz',
      );
    });
  });

  describe('queueDayClose — lock guard + heartbeat (T174, M5)', () => {
    it('acquires the lock, closes unresolved entries, and heartbeats on a COMPLETED run', async () => {
      const { processor, lock, metrics, patientQueue } = build('token-abc');

      const result = await processor.process({
        name: JOB.PLATFORM_QUEUE_DAY_CLOSE,
        data: {},
      } as any);

      expect(patientQueue.closeUnresolvedEntries).toHaveBeenCalled();
      expect(result).toEqual({ closed: 4 });
      expect(lock.release).toHaveBeenCalledWith(
        'lock:queue-day-close',
        'token-abc',
      );
      expect(metrics.setWorkerHeartbeat).toHaveBeenCalledWith(
        'platform.queueDayClose',
      );
    });

    it('is idempotent — re-running with nothing left unresolved still heartbeats, closing zero', async () => {
      const { processor, metrics, patientQueue } = build('token-abc');
      patientQueue.closeUnresolvedEntries.mockResolvedValue({ closed: 0 });

      const result = await processor.process({
        name: JOB.PLATFORM_QUEUE_DAY_CLOSE,
        data: {},
      } as any);

      expect(result).toEqual({ closed: 0 });
      expect(metrics.setWorkerHeartbeat).toHaveBeenCalledWith(
        'platform.queueDayClose',
      );
    });

    it('M5 — a lock-unavailable run logs a visible skip and emits NO heartbeat', async () => {
      const { processor, lock, metrics, patientQueue } = build(null);
      const logSpy = jest.spyOn((processor as any).logger, 'log');

      const result = await processor.process({
        name: JOB.PLATFORM_QUEUE_DAY_CLOSE,
        data: {},
      } as any);

      expect(patientQueue.closeUnresolvedEntries).not.toHaveBeenCalled();
      expect(result).toEqual({ skipped: true });
      expect(lock.release).not.toHaveBeenCalled();
      // The M5 property under test: no heartbeat on a skipped run.
      expect(metrics.setWorkerHeartbeat).not.toHaveBeenCalled();
      // ...but the skip itself is VISIBLE in the logs.
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('skipping this run'),
      );
    });

    it('still releases the lock if the sweep throws', async () => {
      const { processor, lock, patientQueue } = build('token-xyz');
      patientQueue.closeUnresolvedEntries.mockRejectedValueOnce(
        new Error('db error'),
      );

      await expect(
        processor.process({
          name: JOB.PLATFORM_QUEUE_DAY_CLOSE,
          data: {},
        } as any),
      ).rejects.toThrow('db error');

      expect(lock.release).toHaveBeenCalledWith(
        'lock:queue-day-close',
        'token-xyz',
      );
    });
  });

  describe('exportExpiry — lock guard + heartbeat (T183, M5)', () => {
    it('acquires the lock, expires due exports, and heartbeats on a COMPLETED run — even zero-expired', async () => {
      const { processor, lock, metrics, reportExport } = build('token-abc');

      const result = await processor.process({
        name: JOB.PLATFORM_EXPORT_EXPIRY,
        data: {},
      } as any);

      expect(reportExport.expireDueExports).toHaveBeenCalled();
      expect(result).toEqual({ expired: 0 });
      expect(lock.release).toHaveBeenCalledWith(
        'lock:export-expiry',
        'token-abc',
      );
      expect(metrics.setWorkerHeartbeat).toHaveBeenCalledWith(
        'platform.exportExpiry',
      );
    });

    it('heartbeats with the real expired count when there is work to do', async () => {
      const { processor, metrics, reportExport } = build('token-abc');
      reportExport.expireDueExports.mockResolvedValueOnce({ expired: 7 });

      const result = await processor.process({
        name: JOB.PLATFORM_EXPORT_EXPIRY,
        data: {},
      } as any);

      expect(result).toEqual({ expired: 7 });
      expect(metrics.setWorkerHeartbeat).toHaveBeenCalledWith(
        'platform.exportExpiry',
      );
    });

    it('M5 — a lock-unavailable run logs a visible skip and emits NO heartbeat', async () => {
      const { processor, lock, metrics, reportExport } = build(null);
      const logSpy = jest.spyOn((processor as any).logger, 'log');

      const result = await processor.process({
        name: JOB.PLATFORM_EXPORT_EXPIRY,
        data: {},
      } as any);

      expect(reportExport.expireDueExports).not.toHaveBeenCalled();
      expect(result).toEqual({ skipped: true });
      expect(lock.release).not.toHaveBeenCalled();
      expect(metrics.setWorkerHeartbeat).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('skipping this run'),
      );
    });

    it('still releases the lock if the expiry sweep throws', async () => {
      const { processor, lock, reportExport } = build('token-xyz');
      reportExport.expireDueExports.mockRejectedValueOnce(
        new Error('storage down'),
      );

      await expect(
        processor.process({
          name: JOB.PLATFORM_EXPORT_EXPIRY,
          data: {},
        } as any),
      ).rejects.toThrow('storage down');

      expect(lock.release).toHaveBeenCalledWith(
        'lock:export-expiry',
        'token-xyz',
      );
    });
  });

  describe('waitlistEvaluate (T157/T159/T160)', () => {
    it('re-resolves tenant context and delegates to WaitlistOfferService.evaluateFreedSlot', async () => {
      const { processor, waitlistOffers, authz } = build('token-abc');

      const result = await processor.process({
        name: JOB.PLATFORM_WAITLIST_EVALUATE,
        data: { tenantId: 't1', appointmentId: 'a1' },
      } as any);

      expect(authz.assertAuthorized).toHaveBeenCalledWith(
        JOB.PLATFORM_WAITLIST_EVALUATE,
        expect.objectContaining({ tenantId: 't1', appointmentId: 'a1' }),
      );
      expect(waitlistOffers.evaluateFreedSlot).toHaveBeenCalledWith(
        't1',
        'a1',
        undefined,
      );
      expect(result).toEqual({ offered: 1 });
    });

    it('passes the freed-slot override through for a reschedule-triggered evaluation', async () => {
      const { processor, waitlistOffers } = build('token-abc');

      await processor.process({
        name: JOB.PLATFORM_WAITLIST_EVALUATE,
        data: {
          tenantId: 't1',
          appointmentId: 'a1',
          freedStartAt: '2031-01-01T09:00:00.000Z',
          freedEndAt: '2031-01-01T10:00:00.000Z',
          freedBranchId: 'b1',
          freedStaffId: 's1',
        },
      } as any);

      expect(waitlistOffers.evaluateFreedSlot).toHaveBeenCalledWith(
        't1',
        'a1',
        {
          startAt: new Date('2031-01-01T09:00:00.000Z'),
          endAt: new Date('2031-01-01T10:00:00.000Z'),
          branchId: 'b1',
          staffId: 's1',
        },
      );
    });

    it('rejects a payload missing appointmentId (UnrecoverableError, DLQ-routed)', async () => {
      const { processor } = build('token-abc');

      await expect(
        processor.process({
          name: JOB.PLATFORM_WAITLIST_EVALUATE,
          data: { tenantId: 't1' },
        } as any),
      ).rejects.toThrow(UnrecoverableError);
    });
  });

  describe('other job names — unaffected by the waitlist branches', () => {
    it('still routes platform.authTokenCleanup / default log cleanup correctly', async () => {
      const { processor, authTokens, maintenance } = build('token-abc');

      await processor.process({
        name: JOB.PLATFORM_AUTH_TOKEN_CLEANUP,
        data: {},
      } as any);
      expect(authTokens.purgeExpiredTokens).toHaveBeenCalled();

      await processor.process({
        name: JOB.PLATFORM_LOG_CLEANUP,
        data: {},
      } as any);
      expect(maintenance.purgeOldLogs).toHaveBeenCalled();
    });
  });
});
