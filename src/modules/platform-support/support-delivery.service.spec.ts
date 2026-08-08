import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { ErrorCode } from '../../common/errors';
import {
  createMockDataSource,
  createMockRepository,
  MockDataSource,
  MockRepository,
} from '../../../test/utils/mock-factories';

import { SupportClinicResolver } from './support-clinic.resolver';
import { SupportDeliveryService } from './support-delivery.service';
import { QuerySupportDeliveryDto } from './dto/query-support-diagnostics.dto';

const TENANT_ID = '44444444-4444-4444-8444-444444444444';

const query = (over: Partial<QuerySupportDeliveryDto> = {}) =>
  Object.assign(new QuerySupportDeliveryDto(), over);

describe('SupportDeliveryService', () => {
  let service: SupportDeliveryService;
  let tenants: MockRepository;
  let dataSource: MockDataSource;

  beforeEach(async () => {
    tenants = createMockRepository();
    tenants.exists.mockResolvedValue(true);
    dataSource = createMockDataSource();

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SupportDeliveryService,
        SupportClinicResolver,
        { provide: getRepositoryToken(Tenant), useValue: tenants },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = moduleRef.get(SupportDeliveryService);
  });

  describe('emails', () => {
    const emailRow = {
      id: 'e1',
      to_address: 'mohamed.halem@gmail.com',
      template: 'staff_invitation',
      subject: 'You have been invited',
      locale: 'en',
      status: 'FAILED',
      provider: 'resend',
      provider_message_id: '448490b5-9fa8-4759-9c51-8e695e7f659f',
      error: 'Provider rejected: token=re_live_abcdef contact mohamed.halem@gmail.com',
      attempts: 3,
      created_at: new Date('2026-08-01T10:00:00Z'),
      sent_at: null,
    };

    beforeEach(() => {
      dataSource.query = jest.fn(async (sql: string) =>
        /COUNT\(\*\)/.test(sql) ? [{ total: 1 }] : [emailRow],
      );
    });

    it('masks the recipient address while keeping the domain diagnostically useful', async () => {
      const { data } = await service.emails(TENANT_ID, query());

      expect(data[0].recipient).toBe('m***@gmail.com');
      expect(JSON.stringify(data)).not.toContain('mohamed.halem@gmail.com');
    });

    it('sanitizes the provider failure reason — no credentials, no addresses', async () => {
      const { data } = await service.emails(TENANT_ID, query());

      expect(data[0].failureReason).not.toContain('re_live_abcdef');
      expect(data[0].failureReason).not.toContain('mohamed.halem@gmail.com');
      expect(data[0].failureReason).toContain('[redacted]');
    });

    it('returns exactly the allow-listed delivery keys', async () => {
      const { data } = await service.emails(TENANT_ID, query());

      expect(Object.keys(data[0]).sort()).toEqual(
        [
          'attempts',
          'channel',
          'createdAt',
          'failureReason',
          'id',
          'locale',
          'provider',
          'providerMessageId',
          'recipient',
          'sentAt',
          'status',
          'subject',
          'template',
        ].sort(),
      );
    });

    it('keeps the provider message id — it identifies a message, not a person, and Support quotes it to the provider', async () => {
      const { data } = await service.emails(TENANT_ID, query());

      expect(data[0].providerMessageId).toBe('448490b5-9fa8-4759-9c51-8e695e7f659f');
    });

    it('always bounds the query by a date window and a page size', async () => {
      await service.emails(TENANT_ID, query({ page: 2, limit: 50, days: 7 }));

      const listCall = dataSource.query.mock.calls.find(
        ([sql]: [string]) => !/COUNT\(\*\)/.test(sql),
      )!;
      const [sql, params] = listCall;
      expect(sql).toContain('created_at >= $2');
      expect(sql).toContain('LIMIT');
      expect(sql).toContain('OFFSET');
      expect(params).toEqual(expect.arrayContaining([TENANT_ID, 50, 50]));
    });

    it('filters by recipient against the STORED value so a real address still finds the row', async () => {
      await service.emails(TENANT_ID, query({ recipient: 'mohamed.halem@gmail.com' }));

      const [, params] = dataSource.query.mock.calls[0];
      expect(params).toContain('%mohamed.halem@gmail.com%');
    });

    it('normalises the status filter so a lowercase query still matches stored values', async () => {
      await service.emails(TENANT_ID, query({ status: 'failed' }));

      const [, params] = dataSource.query.mock.calls[0];
      expect(params).toContain('FAILED');
    });

    it('reports the pagination envelope including the window actually applied', async () => {
      const result = await service.emails(TENANT_ID, query({ days: 14, page: 3, limit: 10 }));

      expect(result).toMatchObject({ total: 1, page: 3, limit: 10, windowDays: 14 });
    });

    it('404s an unknown clinic before querying', async () => {
      tenants.exists.mockResolvedValue(false);

      await expect(service.emails(TENANT_ID, query())).rejects.toMatchObject({
        code: ErrorCode.TENANT_NOT_FOUND,
      });
      expect(dataSource.query).not.toHaveBeenCalled();
    });
  });

  describe('notifications', () => {
    const notificationRow = {
      id: 'n1',
      template_id: 'appointment_reminder',
      recipient_type: 'CUSTOMER',
      recipient_id: 'cust-uuid-1',
      channel: 'WHATSAPP',
      status: 'SEND_UNCERTAIN',
      provider_ref: 'wamid.ABC',
      error_message: 'stale-processing-after-send-attempt: verify with the provider before retrying',
      created_at: new Date('2026-08-01T10:00:00Z'),
      sent_at: null,
      claimed_at: new Date('2026-08-01T10:00:05Z'),
    };

    beforeEach(() => {
      dataSource.query = jest.fn(async (sql: string) =>
        /COUNT\(\*\)/.test(sql) ? [{ total: 1 }] : [notificationRow],
      );
    });

    it('surfaces SEND_UNCERTAIN verbatim rather than folding it into FAILED', async () => {
      const { data } = await service.notifications(TENANT_ID, query());

      expect(data[0].status).toBe('SEND_UNCERTAIN');
    });

    it('exposes claimedAt so "in flight" is distinguishable from "the worker died holding it"', async () => {
      const { data } = await service.notifications(TENANT_ID, query());

      expect(data[0].claimedAt).toBe('2026-08-01T10:00:05.000Z');
      expect(data[0].sentAt).toBeNull();
    });

    it('returns the recipient as an opaque id only — never a name, phone or address', async () => {
      const { data } = await service.notifications(TENANT_ID, query());

      expect(data[0].recipientId).toBe('cust-uuid-1');
      expect(Object.keys(data[0])).not.toContain('recipientName');
      expect(Object.keys(data[0])).not.toContain('recipientPhone');
      expect(Object.keys(data[0]).sort()).toEqual(
        [
          'channel',
          'claimedAt',
          'createdAt',
          'failureReason',
          'id',
          'providerMessageId',
          'recipientId',
          'recipientType',
          'sentAt',
          'status',
          'template',
        ].sort(),
      );
    });

    it('scopes every notification query to the requested clinic', async () => {
      await service.notifications(TENANT_ID, query());

      for (const [sql, params] of dataSource.query.mock.calls) {
        expect(sql).toContain('"tenantId" = $1');
        expect(params[0]).toBe(TENANT_ID);
      }
    });
  });
});
