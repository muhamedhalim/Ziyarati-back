import { PlatformProcessor } from './platform.processor';
import { JOB } from '../../queue/queue.constants';
import { JOB_AUTHZ_POLICY as JOB_AUTHORIZATION } from '../../queue/job-authorization.constants';

/**
 * The two ready-made-rule jobs on the platform queue: each holds a distributed lock
 * for its whole run, renews it, heartbeats only when it actually ran, and releases
 * it even when the sweep throws.
 */
describe('PlatformProcessor — notification rules + scheduled campaign launch', () => {
  const build = (lockToken: string | null = 'tok') => {
    const lock = {
      acquire: jest.fn().mockResolvedValue(lockToken),
      renew: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const metrics = { setWorkerHeartbeat: jest.fn() };
    const rulesSweep = {
      sweep: jest
        .fn()
        .mockResolvedValue({ tenants: 1, processed: 1, scheduled: 4 }),
    };
    const scheduledLaunch = {
      sweep: jest.fn().mockResolvedValue({ due: 2, launched: 2, failed: 0 }),
    };
    const stub = {} as never;
    const processor = new PlatformProcessor(
      stub, // maintenance
      stub, // authTokens
      stub, // ctx
      stub, // authz
      lock as never,
      metrics as never,
      stub, // waitlistEntries
      stub, // waitlistOffers
      stub, // patientQueue
      stub, // reportExport
      stub, // birthdayGreetings
      stub, // freeAccessNotice
      rulesSweep as never,
      scheduledLaunch as never,
    );
    return { processor, lock, metrics, rulesSweep, scheduledLaunch };
  };

  const job = (name: string) => ({ name, data: { tenantId: null } }) as never;

  describe('rules sweep', () => {
    it('runs under a lock, renews it while it works, heartbeats and releases', async () => {
      const { processor, lock, metrics, rulesSweep } = build();
      const out = await processor.process(
        job(JOB.PLATFORM_NOTIFICATION_RULES_SWEEP),
      );

      expect(out).toEqual({ tenants: 1, processed: 1, scheduled: 4 });
      expect(lock.acquire).toHaveBeenCalledWith(
        'lock:notification-rules-sweep',
        expect.any(Number),
      );
      expect(rulesSweep.sweep).toHaveBeenCalledTimes(1);

      // The sweep is handed a keep-alive that renews THIS run's lock.
      const { keepAlive } = rulesSweep.sweep.mock.calls[0][1];
      await keepAlive();
      expect(lock.renew).toHaveBeenCalledWith(
        'lock:notification-rules-sweep',
        'tok',
        expect.any(Number),
      );

      expect(metrics.setWorkerHeartbeat).toHaveBeenCalledWith(
        'platform.notificationRulesSweep',
      );
      expect(lock.release).toHaveBeenCalledWith(
        'lock:notification-rules-sweep',
        'tok',
      );
    });

    it('skips, without a heartbeat, when another worker holds the lock', async () => {
      const { processor, rulesSweep, metrics, lock } = build(null);
      const out = await processor.process(
        job(JOB.PLATFORM_NOTIFICATION_RULES_SWEEP),
      );
      expect(out).toEqual({ skipped: true });
      expect(rulesSweep.sweep).not.toHaveBeenCalled();
      expect(metrics.setWorkerHeartbeat).not.toHaveBeenCalled();
      expect(lock.release).not.toHaveBeenCalled();
    });

    it('releases the lock even when the sweep throws', async () => {
      const { processor, rulesSweep, lock, metrics } = build();
      rulesSweep.sweep.mockRejectedValue(new Error('boom'));
      await expect(
        processor.process(job(JOB.PLATFORM_NOTIFICATION_RULES_SWEEP)),
      ).rejects.toThrow('boom');
      expect(lock.release).toHaveBeenCalledWith(
        'lock:notification-rules-sweep',
        'tok',
      );
      expect(metrics.setWorkerHeartbeat).not.toHaveBeenCalled();
    });
  });

  describe('scheduled campaign launch', () => {
    it('runs under its own lock and heartbeats', async () => {
      const { processor, lock, metrics, scheduledLaunch } = build();
      const out = await processor.process(
        job(JOB.PLATFORM_CAMPAIGNS_SCHEDULED_LAUNCH),
      );

      expect(out).toEqual({ due: 2, launched: 2, failed: 0 });
      expect(lock.acquire).toHaveBeenCalledWith(
        'lock:campaigns-scheduled-launch',
        expect.any(Number),
      );
      expect(scheduledLaunch.sweep).toHaveBeenCalledTimes(1);
      expect(metrics.setWorkerHeartbeat).toHaveBeenCalledWith(
        'platform.campaignsScheduledLaunch',
      );
      expect(lock.release).toHaveBeenCalledWith(
        'lock:campaigns-scheduled-launch',
        'tok',
      );
    });

    it('the lock expires before the next minute tick, so a crashed run cannot block it for long', async () => {
      const { processor, lock } = build();
      await processor.process(job(JOB.PLATFORM_CAMPAIGNS_SCHEDULED_LAUNCH));
      expect(lock.acquire.mock.calls[0][1]).toBeLessThanOrEqual(60_000);
    });

    it('skips quietly when another worker is already launching', async () => {
      const { processor, scheduledLaunch } = build(null);
      const out = await processor.process(
        job(JOB.PLATFORM_CAMPAIGNS_SCHEDULED_LAUNCH),
      );
      expect(out).toEqual({ skipped: true });
      expect(scheduledLaunch.sweep).not.toHaveBeenCalled();
    });

    it('releases the lock when the sweep throws', async () => {
      const { processor, scheduledLaunch, lock } = build();
      scheduledLaunch.sweep.mockRejectedValue(new Error('db'));
      await expect(
        processor.process(job(JOB.PLATFORM_CAMPAIGNS_SCHEDULED_LAUNCH)),
      ).rejects.toThrow('db');
      expect(lock.release).toHaveBeenCalled();
    });
  });

  it('a processor built without the services has nothing to run for these jobs', async () => {
    const stub = {} as never;
    const p = new PlatformProcessor(
      stub,
      stub,
      stub,
      stub,
      stub,
      stub,
      stub,
      stub,
      stub,
      stub,
      stub,
      stub,
    );
    expect(await p.process(job(JOB.PLATFORM_NOTIFICATION_RULES_SWEEP))).toEqual(
      { skipped: true },
    );
    expect(
      await p.process(job(JOB.PLATFORM_CAMPAIGNS_SCHEDULED_LAUNCH)),
    ).toEqual({ skipped: true });
  });

  it('both jobs are SYSTEM tier: no tenant or user identity can be forged through the payload', () => {
    // Same tier as the birthday and free-access sweeps.
    expect(JOB_AUTHORIZATION[JOB.PLATFORM_NOTIFICATION_RULES_SWEEP]).toBe(
      JOB_AUTHORIZATION[JOB.PLATFORM_BIRTHDAY_GREETINGS],
    );
    expect(JOB_AUTHORIZATION[JOB.PLATFORM_CAMPAIGNS_SCHEDULED_LAUNCH]).toBe(
      JOB_AUTHORIZATION[JOB.PLATFORM_BIRTHDAY_GREETINGS],
    );
  });
});
