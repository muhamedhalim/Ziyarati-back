import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { NotificationDispatchService } from './notification-dispatch.service';
import { NotificationLogService } from './notification-log.service';
import { ScheduledNotification } from '../../entities/Notifications/ScheduledNotification';
import { QueueService } from '../../queue/queue.service';
import { TenantRateLimiterService } from '../../queue/tenant-rate-limiter.service';
import { WhatsappExecutionService } from '../whatsapp/whatsapp-execution.service';
import { TransientNotificationError } from './notification-dispatch.errors';
import { NOTIFICATION_CHANNEL, RECIPIENT_TYPE } from './notification.constants';
import {
  createMockRepository,
  createMockQueryBuilder,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';
const ID = 'notif-1';

describe('NotificationDispatchService.processScheduled', () => {
  let service: NotificationDispatchService;
  let scheduled: MockRepository;
  let logs: { record: jest.Mock; purgeOlderThan: jest.Mock };
  let queue: { enqueueNotificationDispatchBulk: jest.Mock };
  let rateLimiter: { consume: jest.Mock };
  let whatsapp: { sendTemplateMessage: jest.Mock };

  const whatsappNotification = (overrides: Record<string, unknown> = {}) => ({
    id: ID,
    tenant: { id: TENANT },
    template: { id: 'tmpl-1', channel: NOTIFICATION_CHANNEL.WHATSAPP, provider_template_id: 'ptid', variables: {} },
    recipient_type: RECIPIENT_TYPE.CUSTOMER,
    recipient_id: 'cust-1',
    variables: {},
    ...overrides,
  });

  beforeEach(async () => {
    scheduled = createMockRepository();
    logs = { record: jest.fn().mockResolvedValue(undefined), purgeOlderThan: jest.fn().mockResolvedValue(0) };
    queue = { enqueueNotificationDispatchBulk: jest.fn().mockResolvedValue([]) };
    rateLimiter = { consume: jest.fn().mockResolvedValue({ allowed: true }) };
    whatsapp = { sendTemplateMessage: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationDispatchService,
        { provide: getRepositoryToken(ScheduledNotification), useValue: scheduled },
        { provide: NotificationLogService, useValue: logs },
        { provide: QueueService, useValue: queue },
        { provide: TenantRateLimiterService, useValue: rateLimiter },
        { provide: WhatsappExecutionService, useValue: whatsapp },
      ],
    }).compile();
    service = moduleRef.get(NotificationDispatchService);
  });

  afterEach(() => jest.clearAllMocks());

  /** Make the atomic CLAIM affect `n` rows. */
  const claimAffects = (n: number) => {
    const qb = createMockQueryBuilder();
    qb.execute.mockResolvedValue({ affected: n });
    scheduled.createQueryBuilder.mockReturnValueOnce(qb);
  };

  it('no-ops when the CLAIM affects no rows (already claimed/terminal)', async () => {
    claimAffects(0);
    const res = await service.processScheduled(TENANT, ID);
    expect(res).toEqual({ status: 'noop', reason: 'already-claimed-or-terminal' });
  });

  it('no-ops when the row vanished after claiming', async () => {
    scheduled.findOne.mockResolvedValueOnce(null);
    const res = await service.processScheduled(TENANT, ID);
    expect(res).toMatchObject({ status: 'noop', reason: 'vanished' });
  });

  it('marks PERMANENT for a non-WhatsApp channel (no provider)', async () => {
    scheduled.findOne.mockResolvedValueOnce(
      whatsappNotification({ template: { id: 't', channel: NOTIFICATION_CHANNEL.IN_APP } }),
    );
    const res = await service.processScheduled(TENANT, ID);
    expect(res).toMatchObject({ status: 'failed_permanent' });
    expect(logs.record).toHaveBeenCalled();
  });

  it('marks PERMANENT when the template is not linked to an approved WhatsApp template', async () => {
    scheduled.findOne.mockResolvedValueOnce(
      whatsappNotification({ template: { id: 't', channel: NOTIFICATION_CHANNEL.WHATSAPP, provider_template_id: null } }),
    );
    const res = await service.processScheduled(TENANT, ID);
    expect(res).toMatchObject({ status: 'failed_permanent' });
  });

  it('marks PERMANENT when the recipient is not a CUSTOMER', async () => {
    scheduled.findOne.mockResolvedValueOnce(
      whatsappNotification({ recipient_type: RECIPIENT_TYPE.STAFF }),
    );
    const res = await service.processScheduled(TENANT, ID);
    expect(res).toMatchObject({ status: 'failed_permanent' });
  });

  it('defers (rate_limited) and re-schedules without sending on a RATE denial', async () => {
    scheduled.findOne.mockResolvedValueOnce(whatsappNotification());
    rateLimiter.consume.mockResolvedValueOnce({ allowed: false, reason: 'RATE', retryAfterMs: 500 });
    const res = await service.processScheduled(TENANT, ID);
    expect(res).toEqual({ status: 'rate_limited', retryAfterMs: 500 });
    expect(whatsapp.sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('prevents a duplicate send when the send-phase guard loses (at-most-once)', async () => {
    scheduled.findOne.mockResolvedValueOnce(whatsappNotification());
    scheduled.update.mockResolvedValueOnce({ affected: 0 }); // enter-send-phase guard fails
    const res = await service.processScheduled(TENANT, ID);
    expect(res).toMatchObject({ status: 'noop', reason: 'duplicate-send-prevented' });
    expect(whatsapp.sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('marks PERMANENT when the WhatsApp send throws (validation/quota/account)', async () => {
    scheduled.findOne.mockResolvedValueOnce(whatsappNotification());
    whatsapp.sendTemplateMessage.mockRejectedValueOnce(new Error('template not approved'));
    const res = await service.processScheduled(TENANT, ID);
    expect(res).toMatchObject({ status: 'failed_permanent', reason: 'template not approved' });
  });

  it('marks SENT and stores the provider ref on success', async () => {
    scheduled.findOne.mockResolvedValueOnce(whatsappNotification());
    whatsapp.sendTemplateMessage.mockResolvedValueOnce({ status: 'SENT', providerMessageId: 'wamid-1' });
    const res = await service.processScheduled(TENANT, ID);
    expect(res).toEqual({ status: 'sent', providerRef: 'wamid-1' });
  });

  it('re-schedules and throws TransientNotificationError on a provider send failure', async () => {
    scheduled.findOne.mockResolvedValueOnce(whatsappNotification());
    whatsapp.sendTemplateMessage.mockResolvedValueOnce({ status: 'FAILED' });
    await expect(service.processScheduled(TENANT, ID)).rejects.toBeInstanceOf(
      TransientNotificationError,
    );
  });

  describe('reapAndRequeue', () => {
    it('reclaims stale rows, re-enqueues due ones and purges old logs', async () => {
      const reclaimQb = createMockQueryBuilder();
      reclaimQb.execute.mockResolvedValueOnce({ affected: 3 });
      const dueQb = createMockQueryBuilder();
      dueQb.getRawMany.mockResolvedValueOnce([
        { id: 'n1', tenantId: 't1' },
        { id: 'n2', tenantId: 't1' },
      ]);
      scheduled.createQueryBuilder
        .mockReturnValueOnce(reclaimQb)
        .mockReturnValueOnce(dueQb);
      logs.purgeOlderThan.mockResolvedValueOnce(7);

      const res = await service.reapAndRequeue();

      expect(res).toEqual({ reclaimed: 3, requeued: 2, purgedLogs: 7 });
      expect(queue.enqueueNotificationDispatchBulk).toHaveBeenCalledWith([
        { tenantId: 't1', notificationId: 'n1' },
        { tenantId: 't1', notificationId: 'n2' },
      ]);
    });
  });
});
