import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';

import { NotificationDispatchService } from './notification-dispatch.service';
import { NotificationLogService } from './notification-log.service';
import { ScheduledNotification } from '../../entities/Notifications/ScheduledNotification';
import { Customer } from '../../entities/CRM/Customer';
import { QueueService } from '../../queue/queue.service';
import { TenantRateLimiterService } from '../../queue/tenant-rate-limiter.service';
import { WhatsappExecutionService } from '../whatsapp/whatsapp-execution.service';
import { TransientNotificationError } from './notification-dispatch.errors';
import { NOTIFICATION_CHANNEL, RECIPIENT_TYPE } from './notification.constants';
import { AppError, ErrorCode } from '../../common/errors';
import { USAGE_METRIC } from '../subscription-billing/usage-metric';
import { NotificationChannelFactory } from './channels/notification-channel.factory';
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
  let customers: MockRepository;
  let logs: { record: jest.Mock; purgeOlderThan: jest.Mock };
  let queue: { enqueueNotificationDispatchBulk: jest.Mock };
  let rateLimiter: { consume: jest.Mock };
  let whatsapp: { sendTemplateMessage: jest.Mock };
  let config: { get: jest.Mock };
  let emailProvider: { send: jest.Mock };
  let channelFactory: { resolve: jest.Mock };

  const whatsappNotification = (overrides: Record<string, unknown> = {}) => ({
    id: ID,
    tenant: { id: TENANT },
    template: {
      id: 'tmpl-1',
      channel: NOTIFICATION_CHANNEL.WHATSAPP,
      provider_template_id: 'ptid',
      variables: {},
      content_en: 'hello',
    },
    recipient_type: RECIPIENT_TYPE.CUSTOMER,
    recipient_id: 'cust-1',
    variables: {},
    ...overrides,
  });

  /** A recipient with BOTH a valid phone and an email — the common case. */
  const defaultCustomer = (overrides: Record<string, unknown> = {}) => ({
    id: 'cust-1',
    preferred_locale: null,
    phone: '+15551234567',
    email: 'patient@example.com',
    opted_out_at: null,
    ...overrides,
  });

  beforeEach(async () => {
    scheduled = createMockRepository();
    customers = createMockRepository();
    customers.findOne.mockResolvedValue(defaultCustomer());
    logs = {
      record: jest.fn().mockResolvedValue(undefined),
      purgeOlderThan: jest.fn().mockResolvedValue(0),
    };
    queue = {
      enqueueNotificationDispatchBulk: jest.fn().mockResolvedValue([]),
    };
    rateLimiter = { consume: jest.fn().mockResolvedValue({ allowed: true }) };
    whatsapp = { sendTemplateMessage: jest.fn() };
    config = { get: jest.fn().mockReturnValue('en') };
    emailProvider = {
      send: jest
        .fn()
        .mockResolvedValue({ success: true, providerRef: 'email-1' }),
    };
    channelFactory = {
      resolve: jest.fn((channel?: string) => {
        if (channel === NOTIFICATION_CHANNEL.WHATSAPP)
          return { name: 'meta-whatsapp-cloud' };
        if (channel === NOTIFICATION_CHANNEL.EMAIL) return emailProvider;
        throw new Error(`no provider for channel "${channel ?? 'UNKNOWN'}"`);
      }),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationDispatchService,
        {
          provide: getRepositoryToken(ScheduledNotification),
          useValue: scheduled,
        },
        { provide: getRepositoryToken(Customer), useValue: customers },
        { provide: NotificationLogService, useValue: logs },
        { provide: QueueService, useValue: queue },
        { provide: TenantRateLimiterService, useValue: rateLimiter },
        { provide: WhatsappExecutionService, useValue: whatsapp },
        { provide: ConfigService, useValue: config },
        { provide: NotificationChannelFactory, useValue: channelFactory },
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
    expect(res).toEqual({
      status: 'noop',
      reason: 'already-claimed-or-terminal',
    });
  });

  it('no-ops when the row vanished after claiming', async () => {
    scheduled.findOne.mockResolvedValueOnce(null);
    const res = await service.processScheduled(TENANT, ID);
    expect(res).toMatchObject({ status: 'noop', reason: 'vanished' });
  });

  it('marks PERMANENT for a non-WhatsApp channel (no provider)', async () => {
    scheduled.findOne.mockResolvedValueOnce(
      whatsappNotification({
        template: { id: 't', channel: NOTIFICATION_CHANNEL.IN_APP },
      }),
    );
    const res = await service.processScheduled(TENANT, ID);
    expect(res).toMatchObject({ status: 'failed_permanent' });
    expect(logs.record).toHaveBeenCalled();
  });

  // ── T014 (spec 014): WhatsApp-first / email-fallback ──────────────────
  describe('channel fallback (T014, FR-G010)', () => {
    it('falls back to email when the clinic has no approved WhatsApp template', async () => {
      scheduled.findOne.mockResolvedValueOnce(
        whatsappNotification({
          template: {
            id: 't',
            channel: NOTIFICATION_CHANNEL.WHATSAPP,
            provider_template_id: null,
            content_en: 'hello',
          },
        }),
      );
      const res = await service.processScheduled(TENANT, ID);
      expect(whatsapp.sendTemplateMessage).not.toHaveBeenCalled();
      expect(emailProvider.send).toHaveBeenCalledWith(
        expect.objectContaining({ recipientEmail: 'patient@example.com' }),
      );
      expect(res).toEqual({ status: 'sent', providerRef: 'email-1' });
    });

    it('falls back to email when the recipient has no reachable WhatsApp identity', async () => {
      customers.findOne.mockResolvedValueOnce(defaultCustomer({ phone: '' }));
      scheduled.findOne.mockResolvedValueOnce(whatsappNotification());
      const res = await service.processScheduled(TENANT, ID);
      expect(whatsapp.sendTemplateMessage).not.toHaveBeenCalled();
      expect(emailProvider.send).toHaveBeenCalled();
      expect(res).toEqual({ status: 'sent', providerRef: 'email-1' });
    });

    it('falls back to email when WhatsApp returns a PERMANENT failure — quota reservation was still invoked', async () => {
      scheduled.findOne.mockResolvedValueOnce(whatsappNotification());
      whatsapp.sendTemplateMessage.mockRejectedValueOnce(
        new Error('account not approved'),
      );
      const res = await service.processScheduled(TENANT, ID);
      // The WhatsApp seam (and therefore its quota reservation) WAS invoked —
      // the fallback happens only after it fails, never instead of trying.
      expect(whatsapp.sendTemplateMessage).toHaveBeenCalled();
      expect(emailProvider.send).toHaveBeenCalled();
      expect(res).toEqual({ status: 'sent', providerRef: 'email-1' });
    });

    it('T053 (FR-M009): does NOT fall back to email when the WhatsApp quota is exhausted — records QUOTA_EXHAUSTED', async () => {
      scheduled.findOne.mockResolvedValueOnce(whatsappNotification());
      whatsapp.sendTemplateMessage.mockRejectedValueOnce(
        new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: 'Usage limit reached for WHATSAPP_MESSAGES (100/100)',
          publicContext: {
            metric: USAGE_METRIC.WHATSAPP_MESSAGES,
            used: 100,
            limit: 100,
            requested: 1,
          },
        }),
      );
      const res = await service.processScheduled(TENANT, ID);

      expect(whatsapp.sendTemplateMessage).toHaveBeenCalled();
      // The whole point: an over-quota clinic must not get an unmetered
      // email as a free substitute for the channel it ran out of.
      expect(emailProvider.send).not.toHaveBeenCalled();
      expect(res).toMatchObject({ status: 'failed_permanent' });
      expect(scheduled.update).toHaveBeenCalledWith(
        { id: ID },
        expect.objectContaining({ skip_reason: 'QUOTA_EXHAUSTED' }),
      );
    });

    it('does NOT fall back on a TRANSIENT WhatsApp failure — retries WhatsApp itself instead', async () => {
      scheduled.findOne.mockResolvedValueOnce(whatsappNotification());
      whatsapp.sendTemplateMessage.mockResolvedValueOnce({ status: 'FAILED' });
      await expect(service.processScheduled(TENANT, ID)).rejects.toBeInstanceOf(
        TransientNotificationError,
      );
      expect(emailProvider.send).not.toHaveBeenCalled();
    });

    it('an opted-out recipient is reached on NO channel — not even as a fallback', async () => {
      customers.findOne.mockResolvedValueOnce(
        defaultCustomer({ opted_out_at: new Date() }),
      );
      scheduled.findOne.mockResolvedValueOnce(
        whatsappNotification({
          template: {
            id: 't',
            channel: NOTIFICATION_CHANNEL.WHATSAPP,
            provider_template_id: null,
          },
        }),
      );
      const res = await service.processScheduled(TENANT, ID);
      expect(whatsapp.sendTemplateMessage).not.toHaveBeenCalled();
      expect(emailProvider.send).not.toHaveBeenCalled();
      expect(res).toMatchObject({ status: 'failed_permanent' });
    });

    it('at-most-once is preserved across a fallback — a replay after a fallback send does nothing', async () => {
      scheduled.findOne.mockResolvedValueOnce(whatsappNotification());
      whatsapp.sendTemplateMessage.mockRejectedValueOnce(
        new Error('permanent'),
      );
      const first = await service.processScheduled(TENANT, ID);
      expect(first).toEqual({ status: 'sent', providerRef: 'email-1' });

      // Replay: the send-phase guard now loses (send_attempted already true).
      scheduled.findOne.mockResolvedValueOnce(whatsappNotification());
      scheduled.update.mockResolvedValueOnce({ affected: 0 });
      const replay = await service.processScheduled(TENANT, ID);
      expect(replay).toMatchObject({
        status: 'noop',
        reason: 'duplicate-send-prevented',
      });
      expect(emailProvider.send).toHaveBeenCalledTimes(1); // not called again on replay
    });

    // ── T015: channel/skip_reason written on every terminal outcome ────
    it('T015: writes channel on success', async () => {
      scheduled.findOne.mockResolvedValueOnce(whatsappNotification());
      whatsapp.sendTemplateMessage.mockResolvedValueOnce({
        status: 'SENT',
        providerMessageId: 'w1',
      });
      await service.processScheduled(TENANT, ID);
      expect(scheduled.update).toHaveBeenCalledWith(
        { id: ID },
        expect.objectContaining({
          channel: NOTIFICATION_CHANNEL.WHATSAPP,
          skip_reason: null,
        }),
      );
    });

    it('T015: writes skip_reason (and a null channel) on a suppressed send — no provider was ever attempted', async () => {
      customers.findOne.mockResolvedValueOnce(
        defaultCustomer({ opted_out_at: new Date() }),
      );
      scheduled.findOne.mockResolvedValueOnce(whatsappNotification());
      await service.processScheduled(TENANT, ID);
      expect(scheduled.update).toHaveBeenCalledWith(
        { id: ID },
        expect.objectContaining({ channel: null, skip_reason: 'OPTED_OUT' }),
      );
    });

    it('T015: writes the ATTEMPTED channel (not a skip_reason) on a genuine permanent failure', async () => {
      customers.findOne.mockResolvedValueOnce(defaultCustomer({ email: '' }));
      scheduled.findOne.mockResolvedValueOnce(whatsappNotification());
      whatsapp.sendTemplateMessage.mockRejectedValueOnce(
        new Error('not approved'),
      );
      await service.processScheduled(TENANT, ID);
      expect(scheduled.update).toHaveBeenCalledWith(
        { id: ID },
        expect.objectContaining({
          channel: NOTIFICATION_CHANNEL.WHATSAPP,
          skip_reason: null,
        }),
      );
    });

    it('a genuinely unreachable recipient (no template/phone AND no email) fails permanently', async () => {
      customers.findOne.mockResolvedValueOnce(
        defaultCustomer({ phone: '', email: '' }),
      );
      scheduled.findOne.mockResolvedValueOnce(
        whatsappNotification({
          template: {
            id: 't',
            channel: NOTIFICATION_CHANNEL.WHATSAPP,
            provider_template_id: null,
          },
        }),
      );
      const res = await service.processScheduled(TENANT, ID);
      expect(whatsapp.sendTemplateMessage).not.toHaveBeenCalled();
      expect(emailProvider.send).not.toHaveBeenCalled();
      expect(res).toMatchObject({ status: 'failed_permanent' });
    });
  });

  // ── T157 gap-closure: locale-based WhatsApp template selection (LG-8) ────
  describe('[T157] locale-based template selection', () => {
    it('sends the DEFAULT provider_template_id when the customer has no recorded locale', async () => {
      customers.findOne.mockResolvedValueOnce(
        defaultCustomer({ preferred_locale: null }),
      );
      scheduled.findOne.mockResolvedValueOnce(
        whatsappNotification({
          template: {
            id: 'tmpl-1',
            channel: NOTIFICATION_CHANNEL.WHATSAPP,
            provider_template_id: 'ptid-default',
            provider_template_id_ar: 'ptid-ar',
            variables: {},
          },
        }),
      );
      whatsapp.sendTemplateMessage.mockResolvedValueOnce({
        status: 'SENT',
        providerMessageId: 'w1',
      });
      await service.processScheduled(TENANT, ID);
      expect(whatsapp.sendTemplateMessage).toHaveBeenCalledWith(
        TENANT,
        'ptid-default',
        expect.anything(),
      );
    });

    it('sends provider_template_id_ar when the recipient customer prefers Arabic', async () => {
      customers.findOne.mockResolvedValueOnce(
        defaultCustomer({ preferred_locale: 'ar' }),
      );
      scheduled.findOne.mockResolvedValueOnce(
        whatsappNotification({
          template: {
            id: 'tmpl-1',
            channel: NOTIFICATION_CHANNEL.WHATSAPP,
            provider_template_id: 'ptid-default',
            provider_template_id_ar: 'ptid-ar',
            variables: {},
          },
        }),
      );
      whatsapp.sendTemplateMessage.mockResolvedValueOnce({
        status: 'SENT',
        providerMessageId: 'w1',
      });
      await service.processScheduled(TENANT, ID);
      expect(whatsapp.sendTemplateMessage).toHaveBeenCalledWith(
        TENANT,
        'ptid-ar',
        expect.anything(),
      );
    });

    it('falls back to provider_template_id when the customer prefers Arabic but no Arabic variant is linked (no regression)', async () => {
      customers.findOne.mockResolvedValueOnce(
        defaultCustomer({ preferred_locale: 'ar' }),
      );
      scheduled.findOne.mockResolvedValueOnce(
        whatsappNotification({
          template: {
            id: 'tmpl-1',
            channel: NOTIFICATION_CHANNEL.WHATSAPP,
            provider_template_id: 'ptid-default',
            variables: {},
          },
        }),
      );
      whatsapp.sendTemplateMessage.mockResolvedValueOnce({
        status: 'SENT',
        providerMessageId: 'w1',
      });
      await service.processScheduled(TENANT, ID);
      expect(whatsapp.sendTemplateMessage).toHaveBeenCalledWith(
        TENANT,
        'ptid-default',
        expect.anything(),
      );
    });

    it('marks PERMANENT when the recipient customer row itself is missing — T014 now needs it for the consent gate', async () => {
      customers.findOne.mockResolvedValueOnce(null);
      scheduled.findOne.mockResolvedValueOnce(
        whatsappNotification({
          template: {
            id: 'tmpl-1',
            channel: NOTIFICATION_CHANNEL.WHATSAPP,
            provider_template_id: 'ptid-default',
            provider_template_id_ar: 'ptid-ar',
            variables: {},
          },
        }),
      );
      const res = await service.processScheduled(TENANT, ID);
      expect(res).toMatchObject({ status: 'failed_permanent' });
      expect(whatsapp.sendTemplateMessage).not.toHaveBeenCalled();
    });
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
    rateLimiter.consume.mockResolvedValueOnce({
      allowed: false,
      reason: 'RATE',
      retryAfterMs: 500,
    });
    const res = await service.processScheduled(TENANT, ID);
    expect(res).toEqual({ status: 'rate_limited', retryAfterMs: 500 });
    expect(whatsapp.sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('prevents a duplicate send when the send-phase guard loses (at-most-once)', async () => {
    scheduled.findOne.mockResolvedValueOnce(whatsappNotification());
    scheduled.update.mockResolvedValueOnce({ affected: 0 }); // enter-send-phase guard fails
    const res = await service.processScheduled(TENANT, ID);
    expect(res).toMatchObject({
      status: 'noop',
      reason: 'duplicate-send-prevented',
    });
    expect(whatsapp.sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('marks PERMANENT when the WhatsApp send throws AND the recipient has no email to fall back to', async () => {
    customers.findOne.mockResolvedValueOnce(defaultCustomer({ email: '' }));
    scheduled.findOne.mockResolvedValueOnce(whatsappNotification());
    whatsapp.sendTemplateMessage.mockRejectedValueOnce(
      new Error('template not approved'),
    );
    const res = await service.processScheduled(TENANT, ID);
    expect(res).toMatchObject({
      status: 'failed_permanent',
      reason: 'template not approved',
    });
    expect(emailProvider.send).not.toHaveBeenCalled();
  });

  it('marks SENT and stores the provider ref on success', async () => {
    scheduled.findOne.mockResolvedValueOnce(whatsappNotification());
    whatsapp.sendTemplateMessage.mockResolvedValueOnce({
      status: 'SENT',
      providerMessageId: 'wamid-1',
    });
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
    // FND-013 (AD-03): the reclaim step is now two targeted UPDATEs (safe
    // send_attempted=false resume vs. send_attempted=true → SEND_UNCERTAIN),
    // so this pre-existing test's mock sequence grew from 2 query builders to
    // 3 (reclaim, strand, due) and its expected result gained
    // `strandedForReview` — its own purpose (reclaim + re-enqueue + purge)
    // is otherwise unchanged.
    it('reclaims stale rows, re-enqueues due ones and purges old logs', async () => {
      const reclaimQb = createMockQueryBuilder();
      reclaimQb.execute.mockResolvedValueOnce({ affected: 3 });
      const strandQb = createMockQueryBuilder();
      strandQb.execute.mockResolvedValueOnce({ affected: 0 });
      const dueQb = createMockQueryBuilder();
      dueQb.getRawMany.mockResolvedValueOnce([
        { id: 'n1', tenantId: 't1' },
        { id: 'n2', tenantId: 't1' },
      ]);
      scheduled.createQueryBuilder
        .mockReturnValueOnce(reclaimQb)
        .mockReturnValueOnce(strandQb)
        .mockReturnValueOnce(dueQb);
      logs.purgeOlderThan.mockResolvedValueOnce(7);

      const res = await service.reapAndRequeue();

      expect(res).toEqual({
        reclaimed: 3,
        strandedForReview: 0,
        requeued: 2,
        purgedLogs: 7,
      });
      expect(queue.enqueueNotificationDispatchBulk).toHaveBeenCalledWith([
        { tenantId: 't1', notificationId: 'n1' },
        { tenantId: 't1', notificationId: 'n2' },
      ]);
    });

    // ── FND-013 (AD-03) — RED: today the reclaim UPDATE resets EVERY stale
    // PROCESSING row to SCHEDULED regardless of send_attempted, so a row that
    // already entered the send-phase guard is silently cycled back to the
    // worker, immediately re-fails the at-most-once guard, and lands on
    // FAILED as "duplicate-send-prevented" with no operator-visible way out.
    // The reap sweep MUST NOT clear send_attempted (that would risk a real
    // duplicate send) — it must instead route such rows to a distinct,
    // operator-visible terminal state, leaving only genuinely-never-attempted
    // rows (send_attempted=false) to auto-resume as SCHEDULED.
    it('[FND-013/AD-03] excludes rows that already reached the send-phase guard from the automatic SCHEDULED reclaim', async () => {
      const reclaimQb = createMockQueryBuilder();
      reclaimQb.execute.mockResolvedValueOnce({ affected: 0 });
      scheduled.createQueryBuilder.mockReturnValueOnce(reclaimQb);

      await service.reapAndRequeue();

      const predicates = [
        ...reclaimQb.where.mock.calls,
        ...reclaimQb.andWhere.mock.calls,
      ].map((args) => String(args[0]));
      expect(predicates.some((p) => p.includes('send_attempted'))).toBe(true);
    });

    it('[FND-013/AD-03] surfaces already-attempted stale rows as a distinct, counted, operator-visible outcome instead of silently resuming them', async () => {
      const reclaimQb = createMockQueryBuilder();
      reclaimQb.execute.mockResolvedValueOnce({ affected: 0 });
      const strandQb = createMockQueryBuilder();
      strandQb.execute.mockResolvedValueOnce({ affected: 1 });
      const dueQb = createMockQueryBuilder();
      dueQb.getRawMany.mockResolvedValueOnce([]);
      scheduled.createQueryBuilder
        .mockReturnValueOnce(reclaimQb)
        .mockReturnValueOnce(strandQb)
        .mockReturnValueOnce(dueQb);

      const res = await service.reapAndRequeue();

      expect(res.strandedForReview).toBe(1);
    });
  });
});
