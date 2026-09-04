import { UnrecoverableError } from 'bullmq';

import { JOB } from '../../queue/queue.constants';
import { NotificationsProcessor } from './notifications.processor';
import { DistributedLockService } from '../../queue/distributed-lock.service';
import { NotificationDispatchService } from '../../modules/notifications/notification-dispatch.service';
import { QueueService } from '../../queue/queue.service';

describe('NotificationsProcessor — reap sweep lock guard (M9)', () => {
  const build = (lockToken: string | null) => {
    const lock = {
      acquire: jest.fn().mockResolvedValue(lockToken),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const dispatch = {
      reapAndRequeue: jest
        .fn()
        .mockResolvedValue({ reclaimed: 1, requeued: 2, purgedLogs: 3 }),
    };
    const metrics = { setWorkerHeartbeat: jest.fn() };
    /** In-app inbox retention rides on this same sweep. */
    const inApp = { purgeExpired: jest.fn().mockResolvedValue(4) };
    const processor = new NotificationsProcessor(
      dispatch as unknown as NotificationDispatchService,
      {} as any,
      {} as any,
      {} as any,
      lock as unknown as DistributedLockService,
      metrics as any,
      inApp as any,
      {} as any,
    );
    return { processor, lock, dispatch, metrics, inApp };
  };

  it('acquires the lock, runs the reap sweep, and releases the lock afterwards', async () => {
    const { processor, lock, dispatch, metrics, inApp } = build('token-abc');

    const result = await processor.process({
      name: JOB.NOTIFICATIONS_REAP,
      data: {},
    } as any);

    expect(dispatch.reapAndRequeue).toHaveBeenCalled();
    expect(inApp.purgeExpired).toHaveBeenCalled();
    expect(result).toEqual({
      reclaimed: 1,
      requeued: 2,
      purgedLogs: 3,
      purgedInApp: 4,
    });
    expect(lock.release).toHaveBeenCalledWith(
      'lock:notifications-reap',
      'token-abc',
    );
    expect(metrics.setWorkerHeartbeat).toHaveBeenCalledWith(
      'notifications.reap',
    );
  });

  it('still reclaims and requeues when the in-app retention purge fails', async () => {
    // Retention is housekeeping; reclaim/requeue moves real outbound messages.
    // A failure in the former must never cost us the latter — nor the lock.
    const { processor, lock, dispatch, metrics, inApp } = build('token-abc');
    inApp.purgeExpired.mockRejectedValue(new Error('statement timeout'));

    const result = await processor.process({
      name: JOB.NOTIFICATIONS_REAP,
      data: {},
    } as any);

    expect(dispatch.reapAndRequeue).toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({ reclaimed: 1, requeued: 2, purgedInApp: 0 }),
    );
    expect(metrics.setWorkerHeartbeat).toHaveBeenCalledWith(
      'notifications.reap',
    );
    expect(lock.release).toHaveBeenCalledWith(
      'lock:notifications-reap',
      'token-abc',
    );
  });

  it('skips the reap sweep when the lock is already held elsewhere (overlapping run, M9)', async () => {
    const { processor, dispatch, lock } = build(null);

    const result = await processor.process({
      name: JOB.NOTIFICATIONS_REAP,
      data: {},
    } as any);

    expect(dispatch.reapAndRequeue).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: true });
    expect(lock.release).not.toHaveBeenCalled();
  });

  it('still releases the lock if the reap sweep throws', async () => {
    const { processor, lock, dispatch } = build('token-xyz');
    dispatch.reapAndRequeue.mockRejectedValueOnce(new Error('db error'));

    await expect(
      processor.process({ name: JOB.NOTIFICATIONS_REAP, data: {} } as any),
    ).rejects.toThrow('db error');
    expect(lock.release).toHaveBeenCalledWith(
      'lock:notifications-reap',
      'token-xyz',
    );
  });
});

describe('NotificationsProcessor — onFailed DLQ gate (§18 test-plan #20)', () => {
  const build = () => {
    const dispatch = {
      markDeadLettered: jest.fn().mockResolvedValue(undefined),
    };
    const queue = {
      enqueueNotificationDlq: jest.fn().mockResolvedValue(undefined),
    };
    const processor = new NotificationsProcessor(
      dispatch as unknown as NotificationDispatchService,
      queue as unknown as QueueService,
      {} as any,
      {} as any,
      {} as any,
      { setWorkerHeartbeat: jest.fn() } as any,
      {} as any,
      {} as any,
    );
    return { processor, dispatch, queue };
  };

  const job = (
    attemptsMade: number,
    opts: Record<string, unknown> = { attempts: 5 },
  ) =>
    ({
      name: JOB.NOTIFICATIONS_DISPATCH,
      id: 'job-1',
      attemptsMade,
      opts,
      data: { tenantId: 't1', notificationId: 'n1' },
    }) as any;

  it('DLQs a transient failure once retries are exhausted', async () => {
    const { processor, dispatch, queue } = build();
    await processor.onFailed(job(5), new Error('smtp timeout'));

    expect(dispatch.markDeadLettered).toHaveBeenCalledWith(
      't1',
      'n1',
      'smtp timeout',
    );
    expect(queue.enqueueNotificationDlq).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't1',
        notificationId: 'n1',
        attemptsMade: 5,
      }),
    );
  });

  it('does nothing yet while transient retries remain', async () => {
    const { processor, dispatch, queue } = build();
    await processor.onFailed(job(2), new Error('smtp timeout'));

    expect(dispatch.markDeadLettered).not.toHaveBeenCalled();
    expect(queue.enqueueNotificationDlq).not.toHaveBeenCalled();
  });

  it('DLQs an UnrecoverableError on the FIRST attempt — before this fix it silently vanished because attemptsMade never reaches opts.attempts for a never-retried error (real gap found + fixed this pass)', async () => {
    const { processor, dispatch, queue } = build();
    await processor.onFailed(
      job(1),
      new UnrecoverableError('payload missing required field "notificationId"'),
    );

    expect(dispatch.markDeadLettered).toHaveBeenCalledWith(
      't1',
      'n1',
      'payload missing required field "notificationId"',
    );
    expect(queue.enqueueNotificationDlq).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't1',
        notificationId: 'n1',
        attemptsMade: 1,
      }),
    );
  });
});

// P1.5 (MS-007) — the outbox-driven replacement for
// `ReminderListener.onCreated`'s post-commit read. See
// `queue.constants.ts`'s `REMINDERS_SCHEDULE` docstring and
// `appointment.service.ts`'s outbox write for the other two ends of this
// path; this covers the consuming side.
describe('NotificationsProcessor — reminders.schedule (P1.5 / MS-007)', () => {
  const build = () => {
    const reminders = { scheduleFor: jest.fn().mockResolvedValue(undefined) };
    const ctx = {
      run: jest.fn((fn: () => unknown) => fn()),
      setPrincipal: jest.fn(),
      setCorrelationId: jest.fn(),
    };
    const authz = { assertAuthorized: jest.fn().mockResolvedValue(undefined) };
    const processor = new NotificationsProcessor(
      {} as any,
      {} as any,
      ctx as any,
      authz as any,
      {} as any,
      { setWorkerHeartbeat: jest.fn() } as any,
      {} as any,
      reminders as any,
    );
    return { processor, reminders, ctx, authz };
  };

  const job = (data: Record<string, unknown>, attemptsMade = 0) =>
    ({
      name: JOB.REMINDERS_SCHEDULE,
      id: 'job-1',
      attemptsMade,
      data,
    }) as any;

  it('calls ReminderSchedulerService.scheduleFor with the tenant and appointment from the job payload', async () => {
    const { processor, reminders } = build();

    await processor.process(job({ tenantId: 't1', appointmentId: 'appt-1' }));

    expect(reminders.scheduleFor).toHaveBeenCalledWith('t1', 'appt-1');
  });

  it('runs inside the tenant context with authorization checked first', async () => {
    const { processor, ctx, authz } = build();

    await processor.process(job({ tenantId: 't1', appointmentId: 'appt-1' }));

    expect(authz.assertAuthorized).toHaveBeenCalledWith(
      JOB.REMINDERS_SCHEDULE,
      expect.objectContaining({ tenantId: 't1', appointmentId: 'appt-1' }),
    );
    expect(ctx.run).toHaveBeenCalled();
  });

  it('rejects a payload missing appointmentId with UnrecoverableError (permanent — DLQ path, not a retry)', async () => {
    const { processor, reminders } = build();

    await expect(
      processor.process(job({ tenantId: 't1' })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(reminders.scheduleFor).not.toHaveBeenCalled();
  });

  it('propagates a transient scheduleFor failure so BullMQ retries (never swallowed)', async () => {
    const { processor, reminders } = build();
    reminders.scheduleFor.mockRejectedValueOnce(new Error('db timeout'));

    await expect(
      processor.process(job({ tenantId: 't1', appointmentId: 'appt-1' })),
    ).rejects.toThrow('db timeout');
  });

  it('never confuses a reminders.schedule job for a notifications.dispatch one — no notificationId is required or read', async () => {
    const { processor, reminders } = build();

    // No `notificationId` anywhere in this payload — if the dispatch branch
    // were reached instead, `validateJobPayload` would throw
    // UnrecoverableError for the missing field.
    await processor.process(job({ tenantId: 't1', appointmentId: 'appt-1' }));

    expect(reminders.scheduleFor).toHaveBeenCalledTimes(1);
  });
});
