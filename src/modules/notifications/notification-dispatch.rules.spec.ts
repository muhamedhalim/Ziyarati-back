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
import {
  NOTIFICATION_CHANNEL,
  NOTIFICATION_STATUS,
  RECIPIENT_TYPE,
} from './notification.constants';
import { AppError, ErrorCode } from '../../common/errors';
import { SEND_REFUSAL_REASON } from '../whatsapp/whatsapp.constants';
import { NotificationChannelFactory } from './channels/notification-channel.factory';
import {
  createMockRepository,
  createMockQueryBuilder,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';
const ID = 'notif-1';

/**
 * What the dispatcher does with a failure — the rules that keep a rule-driven
 * message from retrying forever, from reaching someone who must not be messaged,
 * and from being rerouted to a channel it was never written for.
 */
describe('NotificationDispatchService — failure handling and revalidation', () => {
  let service: NotificationDispatchService;
  let scheduled: MockRepository;
  let customers: MockRepository;
  let whatsapp: { sendTemplateMessage: jest.Mock };
  let emailProvider: { send: jest.Mock };

  const notification = (
    over: Record<string, unknown> = {},
    template: Record<string, unknown> = {},
  ) => ({
    id: ID,
    tenant: { id: TENANT },
    template: {
      id: 'tmpl-1',
      channel: NOTIFICATION_CHANNEL.WHATSAPP,
      provider_template_id: 'ptid',
      variables: {},
      ...template,
    },
    recipient_type: RECIPIENT_TYPE.CUSTOMER,
    recipient_id: 'cust-1',
    variables: {},
    ...over,
  });

  const customer = (over: Record<string, unknown> = {}) => ({
    id: 'cust-1',
    preferred_locale: null,
    phone: '+15551234567',
    email: 'patient@example.com',
    opted_out_at: null,
    ...over,
  });

  /** `scheduled.update` calls that wrote a terminal / skip outcome onto the row. */
  const rowUpdates = () =>
    scheduled.update.mock.calls
      .filter(([where]) => (where as { id?: string }).id === ID)
      .map(([, patch]) => patch as Record<string, unknown>);

  beforeEach(async () => {
    scheduled = createMockRepository();
    customers = createMockRepository();
    customers.findOne.mockResolvedValue(customer());
    whatsapp = { sendTemplateMessage: jest.fn() };
    emailProvider = {
      send: jest
        .fn()
        .mockResolvedValue({ success: true, providerRef: 'email-1' }),
    };
    const channelFactory = {
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
        {
          provide: NotificationLogService,
          useValue: {
            record: jest.fn().mockResolvedValue(undefined),
            purgeOlderThan: jest.fn(),
          },
        },
        {
          provide: QueueService,
          useValue: { enqueueNotificationDispatchBulk: jest.fn() },
        },
        {
          provide: TenantRateLimiterService,
          useValue: { consume: jest.fn().mockResolvedValue({ allowed: true }) },
        },
        { provide: WhatsappExecutionService, useValue: whatsapp },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('en') },
        },
        { provide: NotificationChannelFactory, useValue: channelFactory },
      ],
    }).compile();
    service = moduleRef.get(NotificationDispatchService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── D4: permanent vs transient Meta failures ──────────────────────────────

  describe('Meta failure classification (D4)', () => {
    it.each([131026, 131047, 132015, 132001, 100])(
      'Meta code %i is permanent: no retry, no throw, no re-schedule',
      async (code) => {
        scheduled.findOne.mockResolvedValueOnce(notification());
        whatsapp.sendTemplateMessage.mockResolvedValueOnce({
          status: 'FAILED',
          error: 'not deliverable',
          errorCode: code,
        });

        const res = await service.processScheduled(TENANT, ID);

        expect(res.status).toBe('failed_permanent');
        // Terminal FAILED — and never put back to SCHEDULED for another try.
        expect(
          rowUpdates().some((p) => p.status === NOTIFICATION_STATUS.SCHEDULED),
        ).toBe(false);
        expect(
          rowUpdates().some((p) => p.status === NOTIFICATION_STATUS.FAILED),
        ).toBe(true);
        expect(JSON.stringify(rowUpdates())).toContain('META_PERMANENT');
      },
    );

    it.each([130429, 131048, 131056, 131000])(
      'Meta code %i is transient: re-scheduled and thrown so the queue backs off',
      async (code) => {
        scheduled.findOne.mockResolvedValueOnce(notification());
        whatsapp.sendTemplateMessage.mockResolvedValueOnce({
          status: 'FAILED',
          error: 'slow down',
          errorCode: code,
        });

        await expect(
          service.processScheduled(TENANT, ID),
        ).rejects.toBeInstanceOf(TransientNotificationError);
        expect(
          rowUpdates().some((p) => p.status === NOTIFICATION_STATUS.SCHEDULED),
        ).toBe(true);
      },
    );

    it('an UNKNOWN Meta code stays transient — bounded by attempts and the DLQ, never dropped', async () => {
      scheduled.findOne.mockResolvedValueOnce(notification());
      whatsapp.sendTemplateMessage.mockResolvedValueOnce({
        status: 'FAILED',
        error: 'new thing',
        errorCode: 999999,
      });
      await expect(service.processScheduled(TENANT, ID)).rejects.toBeInstanceOf(
        TransientNotificationError,
      );
    });

    it('a provider failure with no code at all is transient (the previous behaviour)', async () => {
      scheduled.findOne.mockResolvedValueOnce(notification());
      whatsapp.sendTemplateMessage.mockResolvedValueOnce({
        status: 'FAILED',
        error: 'timeout',
      });
      await expect(service.processScheduled(TENANT, ID)).rejects.toBeInstanceOf(
        TransientNotificationError,
      );
    });
  });

  // ── D5: no unsafe fallback ────────────────────────────────────────────────

  describe('no unsafe fallback (D5)', () => {
    const refusal = (reason: string, message: string) =>
      new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message,
        publicContext: { reason },
      });

    it('missing MARKETING consent is a permanent skip and is NEVER rerouted to email', async () => {
      scheduled.findOne.mockResolvedValueOnce(
        notification({}, { content_en: 'Special offer — 20% off' }),
      );
      whatsapp.sendTemplateMessage.mockRejectedValueOnce(
        refusal(
          SEND_REFUSAL_REASON.NO_MARKETING_CONSENT,
          'no marketing consent',
        ),
      );

      const res = await service.processScheduled(TENANT, ID);

      expect(res.status).toBe('failed_permanent');
      expect(emailProvider.send).not.toHaveBeenCalled();
      expect(
        rowUpdates().some((p) => p.skip_reason === 'NO_MARKETING_CONSENT'),
      ).toBe(true);
    });

    it('an opt-out discovered at the send seam is never rerouted to email either', async () => {
      scheduled.findOne.mockResolvedValueOnce(
        notification({}, { content_en: 'hello' }),
      );
      whatsapp.sendTemplateMessage.mockRejectedValueOnce(
        refusal(SEND_REFUSAL_REASON.OPTED_OUT, 'opted out'),
      );
      const res = await service.processScheduled(TENANT, ID);
      expect(res.status).toBe('failed_permanent');
      expect(emailProvider.send).not.toHaveBeenCalled();
      expect(rowUpdates().some((p) => p.skip_reason === 'OPTED_OUT')).toBe(
        true,
      );
    });

    it('content blocked by the policy is not rerouted to email', async () => {
      scheduled.findOne.mockResolvedValueOnce(
        notification({}, { content_en: 'hello' }),
      );
      whatsapp.sendTemplateMessage.mockRejectedValueOnce(
        refusal(SEND_REFUSAL_REASON.CONTENT_POLICY, 'blocked'),
      );
      await service.processScheduled(TENANT, ID);
      expect(emailProvider.send).not.toHaveBeenCalled();
    });

    it('a WhatsApp-only template (no email body) does not fall back to an empty email', async () => {
      scheduled.findOne.mockResolvedValueOnce(notification()); // no content_ar / content_en
      whatsapp.sendTemplateMessage.mockRejectedValueOnce(
        new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: 'template paused',
        }),
      );

      const res = await service.processScheduled(TENANT, ID);

      expect(res.status).toBe('failed_permanent');
      expect(emailProvider.send).not.toHaveBeenCalled();
    });

    it('a permanent Meta failure does not email a WhatsApp-only template either', async () => {
      scheduled.findOne.mockResolvedValueOnce(notification());
      whatsapp.sendTemplateMessage.mockResolvedValueOnce({
        status: 'FAILED',
        error: 'undeliverable',
        errorCode: 131026,
      });
      await service.processScheduled(TENANT, ID);
      expect(emailProvider.send).not.toHaveBeenCalled();
    });

    it('still falls back to email when the template really has an email body', async () => {
      scheduled.findOne.mockResolvedValueOnce(
        notification({}, { content_en: 'hello' }),
      );
      whatsapp.sendTemplateMessage.mockRejectedValueOnce(
        new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: 'template paused',
        }),
      );
      const res = await service.processScheduled(TENANT, ID);
      expect(emailProvider.send).toHaveBeenCalled();
      expect(res).toEqual({ status: 'sent', providerRef: 'email-1' });
    });

    it('a recipient with no phone and a WhatsApp-only template is UNREACHABLE, not an empty email', async () => {
      customers.findOne.mockResolvedValueOnce(customer({ phone: '' }));
      scheduled.findOne.mockResolvedValueOnce(notification());

      const res = await service.processScheduled(TENANT, ID);

      expect(res.status).toBe('failed_permanent');
      expect(emailProvider.send).not.toHaveBeenCalled();
      expect(rowUpdates().some((p) => p.skip_reason === 'UNREACHABLE')).toBe(
        true,
      );
    });
  });

  // ── Revalidation against the appointment ──────────────────────────────────

  describe('appointment revalidation at send time', () => {
    const START = new Date('2026-11-01T10:00:00Z');
    const ref = (kind: string, epoch?: number) =>
      `rule:rule-1:${kind}:appt-1${epoch !== undefined ? `:${epoch}` : ''}`;

    const sendOk = () =>
      whatsapp.sendTemplateMessage.mockResolvedValueOnce({
        status: 'SENT',
        providerMessageId: 'wamid.1',
      });

    it('skips a reminder for an appointment that was CANCELLED after scheduling', async () => {
      scheduled.findOne.mockResolvedValueOnce(
        notification({
          source_ref: ref('before', START.getTime()),
          appointment: { id: 'appt-1', status: 'CANCELLED', start_at: START },
        }),
      );
      const res = await service.processScheduled(TENANT, ID);
      expect(res).toMatchObject({
        status: 'noop',
        reason: 'appointment-changed',
      });
      expect(whatsapp.sendTemplateMessage).not.toHaveBeenCalled();
      expect(rowUpdates()).toContainEqual(
        expect.objectContaining({
          status: NOTIFICATION_STATUS.CANCELLED,
          skip_reason: 'APPOINTMENT_CHANGED',
        }),
      );
    });

    it('skips a reminder when the appointment MOVED (start no longer matches what was scheduled)', async () => {
      scheduled.findOne.mockResolvedValueOnce(
        notification({
          source_ref: ref('before', START.getTime()),
          appointment: {
            id: 'appt-1',
            status: 'CONFIRMED',
            start_at: new Date(START.getTime() + 3_600_000),
          },
        }),
      );
      const res = await service.processScheduled(TENANT, ID);
      expect(res).toMatchObject({
        status: 'noop',
        reason: 'appointment-changed',
      });
      expect(whatsapp.sendTemplateMessage).not.toHaveBeenCalled();
    });

    it('sends a reminder whose appointment is unchanged', async () => {
      scheduled.findOne.mockResolvedValueOnce(
        notification({
          source_ref: ref('before', START.getTime()),
          appointment: { id: 'appt-1', status: 'CONFIRMED', start_at: START },
        }),
      );
      sendOk();
      const res = await service.processScheduled(TENANT, ID);
      expect(res.status).toBe('sent');
    });

    it('skips a post-visit follow-up unless the visit is still COMPLETED', async () => {
      scheduled.findOne.mockResolvedValueOnce(
        notification({
          source_ref: ref('completed'),
          appointment: { id: 'appt-1', status: 'CONFIRMED', start_at: START },
        }),
      );
      const res = await service.processScheduled(TENANT, ID);
      expect(res).toMatchObject({
        status: 'noop',
        reason: 'appointment-changed',
      });

      scheduled.findOne.mockResolvedValueOnce(
        notification({
          source_ref: ref('completed'),
          appointment: { id: 'appt-1', status: 'COMPLETED', start_at: START },
        }),
      );
      sendOk();
      const ok = await service.processScheduled(TENANT, ID);
      expect(ok.status).toBe('sent');
    });

    it('skips a delayed confirmation for a booking cancelled in the meantime', async () => {
      scheduled.findOne.mockResolvedValueOnce(
        notification({
          source_ref: ref('confirmed'),
          appointment: { id: 'appt-1', status: 'CANCELLED', start_at: START },
        }),
      );
      const res = await service.processScheduled(TENANT, ID);
      expect(res).toMatchObject({ status: 'noop' });
      expect(whatsapp.sendTemplateMessage).not.toHaveBeenCalled();
    });

    it('does not touch rows that are not rule-scheduled (reminders, workflow, manual)', async () => {
      scheduled.findOne.mockResolvedValueOnce(
        notification({
          source_ref: 'appointment-reminder:appt-1:1440',
          appointment: { id: 'appt-1', status: 'CANCELLED', start_at: START },
        }),
      );
      sendOk();
      const res = await service.processScheduled(TENANT, ID);
      // The dedicated reminder pipeline owns its own cancellation.
      expect(res.status).toBe('sent');
    });
  });

  it('keeps the at-most-once claim: a row already claimed is a no-op', async () => {
    const qb = createMockQueryBuilder();
    qb.execute.mockResolvedValue({ affected: 0 });
    scheduled.createQueryBuilder.mockReturnValueOnce(qb);
    const res = await service.processScheduled(TENANT, ID);
    expect(res).toEqual({
      status: 'noop',
      reason: 'already-claimed-or-terminal',
    });
    expect(whatsapp.sendTemplateMessage).not.toHaveBeenCalled();
  });
});
