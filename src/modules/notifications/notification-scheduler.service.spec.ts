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
