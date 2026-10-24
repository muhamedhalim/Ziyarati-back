import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';

import { NotificationDispatchService } from './notification-dispatch.service';
import { NotificationLogService } from './notification-log.service';
import { NotificationVariableResolver } from './notification-variable-resolver.service';
import { ScheduledNotification } from '../../entities/Notifications/ScheduledNotification';
import { Customer } from '../../entities/CRM/Customer';
import { QueueService } from '../../queue/queue.service';
import { TenantRateLimiterService } from '../../queue/tenant-rate-limiter.service';
import { WhatsappExecutionService } from '../whatsapp/whatsapp-execution.service';
import { WhatsappTemplateService } from '../whatsapp/whatsapp-template.service';
import { TransientNotificationError } from './notification-dispatch.errors';
import { NOTIFICATION_CHANNEL, RECIPIENT_TYPE } from './notification.constants';
import { AppError, ErrorCode } from '../../common/errors';
import { NotificationChannelFactory } from './channels/notification-channel.factory';
import {
  createMockQueryBuilder,
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';
const ID = 'notif-1';

/**
 * Notification → approved WhatsApp template → variables resolved from trusted
 * rows → send. These cover the seam between the dispatcher and the resolver;
 * the resolver's own rules are in its spec.
 */
describe('NotificationDispatchService — template variable binding', () => {
  let service: NotificationDispatchService;
  let scheduled: MockRepository;
  let customers: MockRepository;
  let whatsapp: { sendTemplateMessage: jest.Mock };
  let waTemplates: { findOne: jest.Mock };
  let resolver: { resolve: jest.Mock };
  let emailProvider: { send: jest.Mock };

  const notification = (over: Record<string, unknown> = {}) => ({
    id: ID,
    tenant: { id: TENANT },
    template: {
      id: 'nt-1',
      channel: NOTIFICATION_CHANNEL.WHATSAPP,
      provider_template_id: 'wa-1',
      variables: { fromTemplate: 'default' },
      content_en: 'hello',
    },
    appointment: { id: 'appt-1' },
    recipient_type: RECIPIENT_TYPE.CUSTOMER,
    recipient_id: 'cust-1',
    variables: { cancelUrl: 'https://app/a/SECRET' },
    ...over,
  });

  beforeEach(async () => {
    scheduled = createMockRepository();
    customers = createMockRepository();
    customers.findOne.mockResolvedValue({
      id: 'cust-1',
      full_name: 'Sara',
      phone: '+966500000000',
      email: 'sara@example.com',
      preferred_locale: null,
      opted_out_at: null,
    });
    whatsapp = { sendTemplateMessage: jest.fn() };
    waTemplates = {
      findOne: jest.fn().mockResolvedValue({
        id: 'wa-1',
        status: 'approved',
        components: {
          components: [
            { type: 'BODY', text: 'Hello {{1}}, see you on {{2}}.' },
          ],
        },
        variable_mapping: { '1': 'patient_name', '2': 'appointment_date' },
      }),
    };
    resolver = {
      resolve: jest.fn().mockResolvedValue({
        variables: { '1': 'Sara', '2': 'Sunday 11 October 2026' },
        unresolved: [],
      }),
    };
    emailProvider = {
      send: jest
        .fn()
        .mockResolvedValue({ success: true, providerRef: 'email-1' }),
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
        {
          provide: NotificationChannelFactory,
          useValue: {
            resolve: jest.fn((c: string) =>
              c === NOTIFICATION_CHANNEL.EMAIL
                ? emailProvider
                : { name: 'meta-whatsapp-cloud' },
            ),
          },
        },
        { provide: WhatsappTemplateService, useValue: waTemplates },
        { provide: NotificationVariableResolver, useValue: resolver },
      ],
    }).compile();
    service = moduleRef.get(NotificationDispatchService);
  });

  afterEach(() => jest.clearAllMocks());

  const claim = () => {
    const qb = createMockQueryBuilder();
    qb.execute.mockResolvedValue({ affected: 1 });
    scheduled.createQueryBuilder.mockReturnValueOnce(qb);
  };

  it('sends the RESOLVED values (not the raw defaults), for the right template and tenant', async () => {
    claim();
    scheduled.findOne.mockResolvedValueOnce(notification());
    scheduled.update.mockResolvedValue({ affected: 1 });
    whatsapp.sendTemplateMessage.mockResolvedValueOnce({
      status: 'SENT',
      providerMessageId: 'wamid.1',
    });

    const res = await service.processScheduled(TENANT, ID);

    expect(res).toEqual({ status: 'sent', providerRef: 'wamid.1' });
    expect(waTemplates.findOne).toHaveBeenCalledWith(TENANT, 'wa-1');
    // The resolver gets the loaded (tenant-scoped) customer and the notification's own appointment.
    expect(resolver.resolve).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ id: 'wa-1' }),
      expect.objectContaining({
        appointmentId: 'appt-1',
        customer: expect.objectContaining({ id: 'cust-1' }),
        // defaults + per-notification values are handed over, not dropped
        supplied: {
          fromTemplate: 'default',
          cancelUrl: 'https://app/a/SECRET',
        },
      }),
    );
    expect(whatsapp.sendTemplateMessage).toHaveBeenCalledWith(TENANT, 'wa-1', {
      customerId: 'cust-1',
      variables: { '1': 'Sara', '2': 'Sunday 11 October 2026' },
    });
  });

  it('never calls WhatsApp when a placeholder cannot be resolved — falls back to email, naming the placeholder', async () => {
    claim();
    scheduled.findOne.mockResolvedValueOnce(notification());
    scheduled.update.mockResolvedValue({ affected: 1 });
    resolver.resolve.mockResolvedValueOnce({
      variables: { '1': 'Sara' },
      unresolved: [{ placeholder: '2', source: 'appointment_date' }],
    });

    const res = await service.processScheduled(TENANT, ID);

    expect(whatsapp.sendTemplateMessage).not.toHaveBeenCalled();
    expect(emailProvider.send).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ status: 'sent', providerRef: 'email-1' });
  });

  it('fails permanently (reason names the placeholder) when unresolved AND there is no email', async () => {
    customers.findOne.mockResolvedValue({
      id: 'cust-1',
      phone: '+966500000000',
      email: null,
      opted_out_at: null,
    });
    claim();
    scheduled.findOne.mockResolvedValueOnce(notification());
    scheduled.update.mockResolvedValue({ affected: 1 });
    resolver.resolve.mockResolvedValueOnce({
      variables: {},
      unresolved: [{ placeholder: '2', source: 'appointment_date' }],
    });

    const res = await service.processScheduled(TENANT, ID);

    expect(whatsapp.sendTemplateMessage).not.toHaveBeenCalled();
    expect(res).toMatchObject({ status: 'failed_permanent' });
    expect((res as { reason: string }).reason).toContain('{{2}}');
  });

  it('a template that was deleted/refused (404/422 from the template service) is permanent, not retried', async () => {
    claim();
    scheduled.findOne.mockResolvedValueOnce(notification());
    scheduled.update.mockResolvedValue({ affected: 1 });
    customers.findOne.mockResolvedValue({
      id: 'cust-1',
      phone: '+966500000000',
      email: null,
      opted_out_at: null,
    });
    waTemplates.findOne.mockRejectedValueOnce(
      new AppError(ErrorCode.NOT_FOUND, { message: 'Template not found' }),
    );

    const res = await service.processScheduled(TENANT, ID);

    expect(res).toMatchObject({ status: 'failed_permanent' });
    expect(whatsapp.sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('a send REFUSED because the template is not approved falls back to email (never retried against Meta)', async () => {
    claim();
    scheduled.findOne.mockResolvedValueOnce(notification());
    scheduled.update.mockResolvedValue({ affected: 1 });
    whatsapp.sendTemplateMessage.mockRejectedValueOnce(
      new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Only approved templates can be sent (current: "paused")',
      }),
    );

    const res = await service.processScheduled(TENANT, ID);

    expect(emailProvider.send).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ status: 'sent', providerRef: 'email-1' });
  });

  it('a transient provider failure re-schedules once and signals retry — it does not loop', async () => {
    claim();
    scheduled.findOne.mockResolvedValueOnce(notification());
    scheduled.update.mockResolvedValue({ affected: 1 });
    whatsapp.sendTemplateMessage.mockResolvedValueOnce({
      status: 'FAILED',
      error: '500: down',
    });

    await expect(service.processScheduled(TENANT, ID)).rejects.toBeInstanceOf(
      TransientNotificationError,
    );
    expect(whatsapp.sendTemplateMessage).toHaveBeenCalledTimes(1);
  });

  it('a replay after the send phase was entered is refused (no second WhatsApp message)', async () => {
    claim();
    scheduled.findOne.mockResolvedValueOnce(notification());
    // send_attempted already true → the guard UPDATE affects nothing
    scheduled.update
      .mockResolvedValueOnce({ affected: 0 })
      .mockResolvedValue({ affected: 1 });

    const res = await service.processScheduled(TENANT, ID);

    expect(res).toMatchObject({
      status: 'noop',
      reason: 'duplicate-send-prevented',
    });
    expect(whatsapp.sendTemplateMessage).not.toHaveBeenCalled();
    expect(emailProvider.send).not.toHaveBeenCalled();
  });
});
