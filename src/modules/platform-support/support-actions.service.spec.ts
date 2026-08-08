import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';
import { StaffAccessService } from '../staff/staff-access.service';
import { NotificationSchedulerService } from '../notifications/notification-scheduler.service';
import {
  PLATFORM_ADMIN_AUDIT_ACTION,
  PlatformAdminAuditService,
} from '../platform/platform-admin-audit.service';
import { QueueService } from '../../queue/queue.service';
import {
  createMockDataSource,
  createMockRepository,
  MockDataSource,
  MockRepository,
} from '../../../test/utils/mock-factories';

import { SupportActionsService } from './support-actions.service';
import { SupportClinicResolver } from './support-clinic.resolver';
import { SupportIntegrationService } from './support-integration.service';
import { SUPPORT_AUDIT_ENTITY } from './platform-support.constants';

const TENANT_ID = '99999999-9999-4999-8999-999999999999';
const EMAIL_LOG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOTIFICATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACTOR_ID = 'support-agent-1';

describe('SupportActionsService', () => {
  let service: SupportActionsService;
  let tenants: MockRepository;
  let dataSource: MockDataSource;
  let staffAccess: { resendInvitation: jest.Mock };
  let notifications: { retry: jest.Mock };
  let audit: { record: jest.Mock };
  let integrations: { overview: jest.Mock };
  let queues: { redisPing: jest.Mock };

  beforeEach(async () => {
    tenants = createMockRepository();
    tenants.exists.mockResolvedValue(true);
    dataSource = createMockDataSource();
    dataSource.query = jest.fn(async (sql: string) => {
      if (/FROM email_logs/.test(sql)) {
        return [
          {
            id: EMAIL_LOG_ID,
            tenant_id: TENANT_ID,
            to_address: 'nurse@clinic.example',
            template: 'staff_invitation',
          },
        ];
      }
      if (/FROM staff_profiles/.test(sql)) return [{ staff_id: 'staff-7' }];
      return [];
    });
    staffAccess = { resendInvitation: jest.fn().mockResolvedValue({ state: 'INVITED' }) };
    notifications = {
      retry: jest
        .fn()
        .mockResolvedValue({ queued: true, notificationId: NOTIFICATION_ID, jobId: 'job-1' }),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    integrations = {
      overview: jest.fn().mockResolvedValue({
        whatsapp: { health: 'degraded' },
        email: { health: 'configured' },
        payments: { health: 'configured' },
        ai: { health: 'not_configured' },
        storage: { health: 'configured' },
        checkedAt: '2026-08-08T00:00:00.000Z',
      }),
    };
    queues = { redisPing: jest.fn().mockResolvedValue(2) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SupportActionsService,
        SupportClinicResolver,
        { provide: getRepositoryToken(Tenant), useValue: tenants },
        { provide: SupportIntegrationService, useValue: integrations },
        { provide: StaffAccessService, useValue: staffAccess },
        { provide: NotificationSchedulerService, useValue: notifications },
        { provide: PlatformAdminAuditService, useValue: audit },
        { provide: QueueService, useValue: queues },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = moduleRef.get(SupportActionsService);
  });

  describe('resendEmail', () => {
    it('resends an eligible invitation and reports what it did', async () => {
      const result = await service.resendEmail(TENANT_ID, EMAIL_LOG_ID, ACTOR_ID);

      expect(result).toEqual({ resent: true, template: 'staff_invitation', staffId: 'staff-7' });
    });

    it('delegates to the SAME service the clinic Owner uses, so the destination is backend-resolved', async () => {
      await service.resendEmail(TENANT_ID, EMAIL_LOG_ID, ACTOR_ID);

      expect(staffAccess.resendInvitation).toHaveBeenCalledWith(TENANT_ID, 'staff-7', ACTOR_ID);
      // The stored address is a LOOKUP KEY only — it is never handed to the
      // delegate as a destination.
      const [args] = staffAccess.resendInvitation.mock.calls;
      expect(args).not.toContain('nurse@clinic.example');
    });

    it('refuses a template that is not on the resendable allow-list, and audits the refusal', async () => {
      dataSource.query = jest.fn(async (sql: string) =>
        /FROM email_logs/.test(sql)
          ? [
              {
                id: EMAIL_LOG_ID,
                tenant_id: TENANT_ID,
                to_address: 'patient@example.com',
                template: 'appointment_receipt',
              },
            ]
          : [],
      );

      await expect(service.resendEmail(TENANT_ID, EMAIL_LOG_ID, ACTOR_ID)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
      expect(staffAccess.resendInvitation).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: PLATFORM_ADMIN_AUDIT_ACTION.SUPPORT_EMAIL_RESEND_REJECTED,
          userId: ACTOR_ID,
          tenantId: TENANT_ID,
        }),
      );
    });

    it('404s an email record belonging to a different clinic — never confirms it exists', async () => {
      dataSource.query = jest.fn(async () => []);

      await expect(service.resendEmail(TENANT_ID, EMAIL_LOG_ID, ACTOR_ID)).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
      const [sql, params] = dataSource.query.mock.calls[0];
      expect(sql).toContain('tenant_id = $2');
      expect(params).toEqual([EMAIL_LOG_ID, TENANT_ID]);
    });

    it('refuses when the original recipient is no longer a staff member of the clinic', async () => {
      dataSource.query = jest.fn(async (sql: string) =>
        /FROM email_logs/.test(sql)
          ? [
              {
                id: EMAIL_LOG_ID,
                tenant_id: TENANT_ID,
                to_address: 'departed@clinic.example',
                template: 'staff_invitation',
              },
            ]
          : [],
      );

      await expect(service.resendEmail(TENANT_ID, EMAIL_LOG_ID, ACTOR_ID)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
      expect(staffAccess.resendInvitation).not.toHaveBeenCalled();
    });

    it('inherits the delegate\'s own refusals — e.g. the person has already signed in', async () => {
      staffAccess.resendInvitation.mockRejectedValue(
        new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: 'This staff member has already signed in',
        }),
      );

      await expect(service.resendEmail(TENANT_ID, EMAIL_LOG_ID, ACTOR_ID)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });

    it('audits the success naming the actual platform employee and the TARGET clinic', async () => {
      await service.resendEmail(TENANT_ID, EMAIL_LOG_ID, ACTOR_ID);

      expect(audit.record).toHaveBeenCalledWith({
        action: PLATFORM_ADMIN_AUDIT_ACTION.SUPPORT_EMAIL_RESENT,
        userId: ACTOR_ID,
        entityType: SUPPORT_AUDIT_ENTITY,
        entityId: EMAIL_LOG_ID,
        tenantId: TENANT_ID,
        after: { template: 'staff_invitation', staffId: 'staff-7' },
      });
    });

    it('puts no address, token or rendered content into the audit metadata', async () => {
      await service.resendEmail(TENANT_ID, EMAIL_LOG_ID, ACTOR_ID);

      const serialized = JSON.stringify(audit.record.mock.calls);
      expect(serialized).not.toContain('nurse@clinic.example');
      expect(serialized).not.toContain('token');
    });

    it('404s an unknown clinic before touching anything', async () => {
      tenants.exists.mockResolvedValue(false);

      await expect(service.resendEmail(TENANT_ID, EMAIL_LOG_ID, ACTOR_ID)).rejects.toMatchObject({
        code: ErrorCode.TENANT_NOT_FOUND,
      });
      expect(dataSource.query).not.toHaveBeenCalled();
    });
  });

  describe('retryNotification', () => {
    it('delegates to the notification domain\'s own audited, status-guarded override', async () => {
      const result = await service.retryNotification(TENANT_ID, NOTIFICATION_ID, ACTOR_ID);

      expect(notifications.retry).toHaveBeenCalledWith(TENANT_ID, NOTIFICATION_ID);
      expect(result).toMatchObject({ queued: true, notificationId: NOTIFICATION_ID });
    });

    it('never constructs a payload — only an id crosses the boundary', async () => {
      await service.retryNotification(TENANT_ID, NOTIFICATION_ID, ACTOR_ID);

      expect(notifications.retry).toHaveBeenCalledTimes(1);
      expect(notifications.retry.mock.calls[0]).toHaveLength(2);
    });

    it('surfaces the delegate\'s refusal for a non-retryable status, and audits the refusal', async () => {
      notifications.retry.mockRejectedValue(
        new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: 'Only failed or send-uncertain notifications can be retried',
        }),
      );

      await expect(
        service.retryNotification(TENANT_ID, NOTIFICATION_ID, ACTOR_ID),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: PLATFORM_ADMIN_AUDIT_ACTION.SUPPORT_NOTIFICATION_RETRY_REJECTED,
          userId: ACTOR_ID,
          entityId: NOTIFICATION_ID,
          tenantId: TENANT_ID,
        }),
      );
    });

    it('audits the success with the actor and the target clinic', async () => {
      await service.retryNotification(TENANT_ID, NOTIFICATION_ID, ACTOR_ID);

      expect(audit.record).toHaveBeenCalledWith({
        action: PLATFORM_ADMIN_AUDIT_ACTION.SUPPORT_NOTIFICATION_RETRIED,
        userId: ACTOR_ID,
        entityType: SUPPORT_AUDIT_ENTITY,
        entityId: NOTIFICATION_ID,
        tenantId: TENANT_ID,
        after: { queued: true, jobId: 'job-1' },
      });
    });

    it('404s an unknown clinic before retrying', async () => {
      tenants.exists.mockResolvedValue(false);

      await expect(
        service.retryNotification(TENANT_ID, NOTIFICATION_ID, ACTOR_ID),
      ).rejects.toMatchObject({ code: ErrorCode.TENANT_NOT_FOUND });
      expect(notifications.retry).not.toHaveBeenCalled();
    });
  });

  describe('recheckIntegrations', () => {
    it('performs health checks only — it re-runs the same read the integrations view runs', async () => {
      const result = await service.recheckIntegrations(TENANT_ID, ACTOR_ID);

      expect(integrations.overview).toHaveBeenCalledWith(TENANT_ID);
      expect(result.whatsapp.health).toBe('degraded');
      expect(result.queueBackend).toEqual({ status: 'up', latencyMs: 2 });
      expect(result.recheckedAt).toEqual(expect.any(String));
    });

    it('mutates no configuration — no repository write, no queue write, no credential touched', async () => {
      await service.recheckIntegrations(TENANT_ID, ACTOR_ID);

      expect(tenants.save).not.toHaveBeenCalled();
      expect(tenants.update).not.toHaveBeenCalled();
      expect(dataSource.query).not.toHaveBeenCalled();
      // The only queue interaction is a liveness ping.
      expect(Object.keys(queues)).toEqual(['redisPing']);
    });

    it('reports the queue backend as down rather than failing the whole recheck', async () => {
      queues.redisPing.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await service.recheckIntegrations(TENANT_ID, ACTOR_ID);

      expect(result.queueBackend).toEqual({ status: 'down', latencyMs: null });
    });

    it('records who triggered it, when, and the resulting verdicts only', async () => {
      await service.recheckIntegrations(TENANT_ID, ACTOR_ID);

      expect(audit.record).toHaveBeenCalledWith({
        action: PLATFORM_ADMIN_AUDIT_ACTION.SUPPORT_INTEGRATION_RECHECKED,
        userId: ACTOR_ID,
        entityType: SUPPORT_AUDIT_ENTITY,
        entityId: TENANT_ID,
        tenantId: TENANT_ID,
        after: {
          whatsapp: 'degraded',
          email: 'configured',
          payments: 'configured',
          ai: 'not_configured',
          storage: 'configured',
        },
      });
    });

    it('404s an unknown clinic', async () => {
      tenants.exists.mockResolvedValue(false);

      await expect(service.recheckIntegrations(TENANT_ID, ACTOR_ID)).rejects.toMatchObject({
        code: ErrorCode.TENANT_NOT_FOUND,
      });
      expect(integrations.overview).not.toHaveBeenCalled();
    });
  });

  it('exposes exactly three actions — no bulk, no retry-all, no queue administration', () => {
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(service)).filter(
      (m) => m !== 'constructor' && !m.startsWith('record'),
    );

    expect(methods.sort()).toEqual(
      ['recheckIntegrations', 'resendEmail', 'retryNotification'].sort(),
    );
    for (const method of methods) {
      expect(method).not.toMatch(/all|bulk|pause|resume|drain|clean|purge|refund|capture/i);
    }
  });
});
