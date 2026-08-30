import { NotificationSchedulerService } from './notification-scheduler.service';
import { ScheduledNotification } from '../../entities/Notifications/ScheduledNotification';
import { NotificationTemplate } from '../../entities/Notifications/NotificationTemplate';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { NotificationDispatchService } from './notification-dispatch.service';
import { QueueService } from '../../queue/queue.service';
import { NOTIFICATION_STATUS } from './notification.constants';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

describe('NotificationSchedulerService.schedule — sourceRef dedupe (gap-closure pass, §0.11)', () => {
  let service: NotificationSchedulerService;
  let scheduled: MockRepository;
  let templates: MockRepository;
  let appointments: MockRepository;
  let queue: { enqueueNotificationDispatch: jest.Mock; removeNotificationDispatch: jest.Mock };

  const dto = { recipientType: 'CUSTOMER', recipientId: 'c1', scheduledAt: new Date(Date.now() + 60_000).toISOString() };

  beforeEach(() => {
    scheduled = createMockRepository();
    templates = createMockRepository();
    appointments = createMockRepository();
    scheduled.create.mockImplementation((v: object) => ({ id: 'sched-1', ...v }));
    scheduled.save.mockImplementation(async (v: object) => v);
    queue = {
      enqueueNotificationDispatch: jest.fn().mockResolvedValue(undefined),
      removeNotificationDispatch: jest.fn().mockResolvedValue(undefined),
    };

    service = new NotificationSchedulerService(
      scheduled as never,
      templates as unknown as never,
      appointments as unknown as never,
      {} as unknown as NotificationDispatchService,
      queue as unknown as QueueService,
      {} as never,
      {} as never,
    );
  });

  it('creates a row and enqueues a dispatch job when no sourceRef is given (unchanged public-endpoint behavior)', async () => {
    const res = await service.schedule('t1', dto as never);

    expect(res.status).toBe(NOTIFICATION_STATUS.SCHEDULED);
    expect(queue.enqueueNotificationDispatch).toHaveBeenCalled();
  });

  it('stamps source_ref on the row when supplied by an internal caller', async () => {
    await service.schedule('t1', dto as never, 'workflow-action:run-1:2');

    expect(scheduled.create).toHaveBeenCalledWith(expect.objectContaining({ source_ref: 'workflow-action:run-1:2' }));
  });

  it('T032 (spec 014): stamps internal-only per-notification variables (e.g. cancelUrl) on the row', async () => {
    await service.schedule('t1', dto as never, undefined, { cancelUrl: 'https://app/cancel/tok' });

    expect(scheduled.create).toHaveBeenCalledWith(
      expect.objectContaining({ variables: { cancelUrl: 'https://app/cancel/tok' } }),
    );
  });

  it('returns the EXISTING row and does NOT enqueue a second dispatch job when a retry hits the unique index on the same sourceRef', async () => {
    const existing = { id: 'sched-1', source_ref: 'workflow-action:run-1:2', status: NOTIFICATION_STATUS.SCHEDULED };
    scheduled.save.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));
    (scheduled.findOne as jest.Mock).mockResolvedValueOnce(existing);

    const res = await service.schedule('t1', dto as never, 'workflow-action:run-1:2');

    expect(res).toBe(existing);
    expect(queue.enqueueNotificationDispatch).not.toHaveBeenCalled();
  });

  it('propagates a non-unique-violation save error rather than swallowing it', async () => {
    scheduled.save.mockRejectedValueOnce(new Error('connection reset'));

    await expect(service.schedule('t1', dto as never, 'workflow-action:run-1:2')).rejects.toThrow('connection reset');
  });

  it('propagates the unique-violation error when NO sourceRef was supplied at all (nothing to look up)', async () => {
    scheduled.save.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));

    await expect(service.schedule('t1', dto as never)).rejects.toThrow('duplicate key');
  });
});

// ── FND-013 (AD-03) — RED: today retry() resets status/processing_at/
// failure_reason/provider_ref but leaves send_attempted untouched. A row that
// already entered the send-phase guard therefore comes back out of retry()
// still guard-true, so the dispatcher's at-most-once check immediately fails
// it again as "duplicate-send-prevented" — retry() is a complete no-op for
// exactly the rows operators need it for. Per AD-03, retry() is the ONE place
// permitted to clear the guard (an explicit, audited human override), and the
// override must be recorded via a notification-domain audit writer mirroring
// the ApiKeyAuditService / PlatformAdminAuditService pattern (constitution
// Principle XXVI — sensitive actions must be audited).
//
// This constructs NotificationSchedulerService with two NEW trailing
// constructor dependencies (audit writer + TenantContextService) that do not
// exist on the class yet, so this block is expected to fail to COMPILE against
// today's 5-argument constructor — the same accepted RED form Wave 1 recorded
// for FND-015 (T013: "4 suites failed to even compile ... proving the audit
// capability didn't exist").
import { NotificationAuditService } from './notification-audit.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';

describe('NotificationSchedulerService.retry — operator override (AD-03, FND-013)', () => {
  let service: NotificationSchedulerService;
  let scheduled: MockRepository;
  let queue: { retryNotificationDispatch: jest.Mock };
  let audit: { record: jest.Mock };
  let tenantContext: { getUser: jest.Mock };

  const failedRow = {
    id: 'notif-1',
    status: NOTIFICATION_STATUS.FAILED,
    send_attempted: true,
    tenant: { id: 't1' },
  };

  beforeEach(() => {
    scheduled = createMockRepository();
    scheduled.findOne.mockResolvedValue(failedRow);
    queue = { retryNotificationDispatch: jest.fn().mockResolvedValue({ id: 'job-9' }) };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    tenantContext = { getUser: jest.fn().mockReturnValue({ id: 'user-1' }) };

    service = new NotificationSchedulerService(
      scheduled as never,
      createMockRepository() as unknown as never,
      createMockRepository() as unknown as never,
      {} as unknown as NotificationDispatchService,
      queue as unknown as QueueService,
      audit as unknown as NotificationAuditService,
      tenantContext as unknown as TenantContextService,
    );
  });

  it('clears send_attempted so the retried row can pass the dispatcher\'s at-most-once guard', async () => {
    await service.retry('t1', 'notif-1');

    expect(scheduled.update).toHaveBeenCalledWith(
      { id: 'notif-1' },
      expect.objectContaining({ send_attempted: false }),
    );
  });

  it('records an audited override naming the acting user', async () => {
    await service.retry('t1', 'notif-1');

    expect(audit.record).toHaveBeenCalledWith(
      expect.stringContaining('retry'),
      't1',
      'user-1',
      'notif-1',
      expect.anything(),
    );
  });
});
