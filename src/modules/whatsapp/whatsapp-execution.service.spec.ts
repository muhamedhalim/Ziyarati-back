import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { WhatsappExecutionService } from './whatsapp-execution.service';
import { NotificationLog } from '../../entities/Notifications/NotificationLog';
import { WhatsappContact } from '../../entities/WhatsApp/WhatsappContact';
import { Customer } from '../../entities/CRM/Customer';
import { WhatsappMessageRouter } from './routing/whatsapp-message.router';
import { WhatsappTemplateService } from './whatsapp-template.service';
import { WhatsappMessagingService } from './whatsapp-messaging.service';
import { QueueService } from '../../queue/queue.service';
import { UsageService } from '../subscription-billing/usage.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { WHATSAPP_DELIVERY_STATUS } from './whatsapp.constants';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';
const ACCOUNT = { id: 'acc-1', mode: 'REAL', phoneNumberId: 'pid-1', source: 'TENANT' as const };
const TEMPLATE = { id: 'tpl-1', name: 'welcome', language: 'en' };

describe('WhatsappExecutionService', () => {
  let service: WhatsappExecutionService;
  let logs: MockRepository;
  let contacts: MockRepository;
  let customers: MockRepository;
  let router: { resolveForSend: jest.Mock };
  let templates: { getSendableTemplate: jest.Mock };
  let messaging: { send: jest.Mock };
  let queue: { enqueueWhatsappSend: jest.Mock };
  let usage: { assertWithinLimit: jest.Mock; increment: jest.Mock };

  beforeEach(async () => {
    logs = createMockRepository();
    contacts = createMockRepository();
    customers = createMockRepository();
    logs.create.mockImplementation((v: object) => ({ ...v }));
    logs.save.mockImplementation(async (v: object) => ({ id: 'log-1', ...v }));

    router = { resolveForSend: jest.fn().mockResolvedValue(ACCOUNT) };
    templates = { getSendableTemplate: jest.fn().mockResolvedValue(TEMPLATE) };
    messaging = { send: jest.fn().mockResolvedValue({ success: true, providerMessageId: 'wamid.1' }) };
    queue = { enqueueWhatsappSend: jest.fn().mockResolvedValue(undefined) };
    usage = {
      assertWithinLimit: jest.fn().mockResolvedValue(undefined),
      increment: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappExecutionService,
        { provide: getRepositoryToken(NotificationLog), useValue: logs },
        { provide: getRepositoryToken(WhatsappContact), useValue: contacts },
        { provide: getRepositoryToken(Customer), useValue: customers },
        { provide: WhatsappMessageRouter, useValue: router },
        { provide: WhatsappTemplateService, useValue: templates },
        { provide: WhatsappMessagingService, useValue: messaging },
        { provide: QueueService, useValue: queue },
        { provide: UsageService, useValue: usage },
        { provide: TenantContextService, useValue: new TenantContextService() },
      ],
    }).compile();
    service = moduleRef.get(WhatsappExecutionService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('sendTemplateMessage', () => {
    it('resolves account/template/recipient, checks quota, sends, and records a SENT log', async () => {
      const res = await service.sendTemplateMessage(TENANT, 'tpl-1', { toWaId: '966500000000' } as any);

      expect(usage.assertWithinLimit).toHaveBeenCalledWith(TENANT, expect.any(String), 1);
      expect(messaging.send).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT, accountId: ACCOUNT.id, to: '966500000000', templateId: TEMPLATE.id }),
      );
      expect(usage.increment).toHaveBeenCalledWith(TENANT, expect.any(String), 1);
      expect(res).toMatchObject({ status: WHATSAPP_DELIVERY_STATUS.SENT, providerMessageId: 'wamid.1' });
    });

    it('does NOT meter usage when the provider reports failure', async () => {
      messaging.send.mockResolvedValueOnce({ success: false, error: 'template paused' });

      const res = await service.sendTemplateMessage(TENANT, 'tpl-1', { toWaId: '966500000000' } as any);

      expect(usage.increment).not.toHaveBeenCalled();
      expect(res).toMatchObject({ status: WHATSAPP_DELIVERY_STATUS.FAILED, error: 'template paused' });
    });

    it('catches a provider throw and records it as a failed send rather than propagating', async () => {
      messaging.send.mockRejectedValueOnce(new Error('ECONNRESET'));

      const res = await service.sendTemplateMessage(TENANT, 'tpl-1', { toWaId: '966500000000' } as any);

      expect(res).toMatchObject({ status: WHATSAPP_DELIVERY_STATUS.FAILED, error: 'ECONNRESET' });
      expect(usage.increment).not.toHaveBeenCalled();
    });

    it('resolves a contact recipient and rejects one with no wa_id', async () => {
      contacts.findOne.mockResolvedValueOnce({ id: 'c1', wa_id: null });

      await expect(
        service.sendTemplateMessage(TENANT, 'tpl-1', { contactId: 'c1' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    it('requires exactly one recipient selector', async () => {
      await expect(
        service.sendTemplateMessage(TENANT, 'tpl-1', {} as any),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    });

    it('propagates quota exhaustion before ever calling the provider', async () => {
      usage.assertWithinLimit.mockRejectedValueOnce(
        Object.assign(new Error('quota exceeded'), { code: ErrorCode.UNPROCESSABLE_ENTITY }),
      );

      await expect(
        service.sendTemplateMessage(TENANT, 'tpl-1', { toWaId: '966500000000' } as any),
      ).rejects.toThrow('quota exceeded');
      expect(messaging.send).not.toHaveBeenCalled();
    });
  });

  describe('scheduleMessage', () => {
    it('validates routing/template/recipient up front and enqueues a delayed send job', async () => {
      const scheduledAt = new Date(Date.now() + 60_000).toISOString();

      const res = await service.scheduleMessage(TENANT, 'tpl-1', {
        toWaId: '966500000000',
        scheduledAt,
      } as any);

      expect(router.resolveForSend).toHaveBeenCalled();
      expect(templates.getSendableTemplate).toHaveBeenCalledWith(TENANT, 'tpl-1');
      expect(queue.enqueueWhatsappSend).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT, templateId: 'tpl-1' }),
        expect.objectContaining({ delay: expect.any(Number) }),
      );
      expect(res).toMatchObject({ status: WHATSAPP_DELIVERY_STATUS.QUEUED });
    });

    it('requires scheduledAt', async () => {
      await expect(
        service.scheduleMessage(TENANT, 'tpl-1', { toWaId: '966500000000' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
      expect(queue.enqueueWhatsappSend).not.toHaveBeenCalled();
    });
  });
});
