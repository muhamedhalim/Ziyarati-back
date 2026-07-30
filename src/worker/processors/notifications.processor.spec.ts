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
    const processor = new NotificationsProcessor(
      dispatch as unknown as NotificationDispatchService,
      {} as any,
      {} as any,
      {} as any,
      lock as unknown as DistributedLockService,
      metrics as any,
    );
    return { processor, lock, dispatch, metrics };
  };

  it('acquires the lock, runs the reap sweep, and releases the lock afterwards', async () => {
    const { processor, lock, dispatch, metrics } = build('token-abc');

    const result = await processor.process({
      name: JOB.NOTIFICATIONS_REAP,
      data: {},
    } as any);

    expect(dispatch.reapAndRequeue).toHaveBeenCalled();
    expect(result).toEqual({ reclaimed: 1, requeued: 2, purgedLogs: 3 });
    expect(lock.release).toHaveBeenCalledWith(
      'lock:notifications-reap',
      'token-abc',
    );
    expect(metrics.setWorkerHeartbeat).toHaveBeenCalledWith(
      'notifications.reap',
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
