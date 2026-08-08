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
import { SupportBookingService } from './support-booking.service';
import { QuerySupportDiagnosticsDto } from './dto/query-support-diagnostics.dto';

const TENANT_ID = '66666666-6666-4666-8666-666666666666';
const APPT_ID = '77777777-7777-4777-8777-777777777777';
const query = (over: Partial<QuerySupportDiagnosticsDto> = {}) =>
  Object.assign(new QuerySupportDiagnosticsDto(), over);

const appointmentRow = {
  id: APPT_ID,
  status: 'PENDING_PAYMENT',
  payment_status: 'UNPAID',
  source: 'PUBLIC_AI',
  created_at: new Date('2026-08-01T08:00:00Z'),
  start_at: new Date('2026-08-05T10:00:00Z'),
  end_at: new Date('2026-08-05T10:30:00Z'),
  booked_timezone: 'Asia/Riyadh',
  currency: 'SAR',
  branch_name: 'Main Branch',
  customer_name: 'Mohamed Abdelhalim',
  customer_phone: '+966501234567',
  customer_email: 'mohamed.halem@gmail.com',
  booked_by_name: null,
  payment_link_count: 1,
  succeeded_payments: 0,
};

describe('SupportBookingService', () => {
  let service: SupportBookingService;
  let tenants: MockRepository;
  let dataSource: MockDataSource;

  beforeEach(async () => {
    tenants = createMockRepository();
    tenants.exists.mockResolvedValue(true);
    dataSource = createMockDataSource();

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SupportBookingService,
        SupportClinicResolver,
        { provide: getRepositoryToken(Tenant), useValue: tenants },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = moduleRef.get(SupportBookingService);
  });

  describe('appointments', () => {
    beforeEach(() => {
      dataSource.query = jest.fn(async (sql: string) =>
        /COUNT\(\*\)::int AS total/.test(sql) ? [{ total: 1 }] : [appointmentRow],
      );
    });

    it('masks patient identity — enough to match the ticket, not enough to identify the person', async () => {
      const { data } = await service.appointments(TENANT_ID, query());

      expect(data[0].customerName).toBe('M*** A***');
      expect(data[0].customerPhone).toBe('+9665*****567');
      const serialized = JSON.stringify(data);
      expect(serialized).not.toContain('Mohamed Abdelhalim');
      expect(serialized).not.toContain('+966501234567');
    });

    it('returns exactly the allow-listed diagnostic keys — nothing clinical', async () => {
      const { data } = await service.appointments(TENANT_ID, query());

      expect(Object.keys(data[0]).sort()).toEqual(
        [
          'bookedTimezone',
          'branchName',
          'createdAt',
          'currency',
          'customerName',
          'customerPhone',
          'hasPaymentLink',
          'hasSucceededPayment',
          'id',
          'paymentExpected',
          'paymentStatus',
          'scheduledEndAt',
          'scheduledStartAt',
          'source',
          'status',
        ].sort(),
      );
    });

    it('never queries the appointment notes column, nor any clinical table', async () => {
      await service.appointments(TENANT_ID, query());

      for (const [sql] of dataSource.query.mock.calls) {
        expect(sql).not.toMatch(/\ba\.notes\b/);
        expect(sql).not.toContain('appointment_notes');
        expect(sql).not.toContain('customer_notes');
        expect(sql).not.toContain('customer_files');
        expect(sql).not.toContain('customer_profiles');
        expect(sql).not.toContain('patients');
      }
    });

    it('reports the booking source so "who created this?" is answerable', async () => {
      const { data } = await service.appointments(TENANT_ID, query());

      expect(data[0].source).toBe('PUBLIC_AI');
    });

    it('surfaces the stuck-payment signature: a link exists but no payment succeeded', async () => {
      const { data } = await service.appointments(TENANT_ID, query());

      expect(data[0].status).toBe('PENDING_PAYMENT');
      expect(data[0].hasPaymentLink).toBe(true);
      expect(data[0].hasSucceededPayment).toBe(false);
      expect(data[0].paymentExpected).toBe(true);
    });

    it('treats INSURANCE as "no online payment expected" rather than an unpaid failure', async () => {
      dataSource.query = jest.fn(async (sql: string) =>
        /COUNT\(\*\)::int AS total/.test(sql)
          ? [{ total: 1 }]
          : [{ ...appointmentRow, payment_status: 'INSURANCE' }],
      );

      const { data } = await service.appointments(TENANT_ID, query());

      expect(data[0].paymentStatus).toBe('INSURANCE');
      expect(data[0].paymentExpected).toBe(false);
      // A payment CLASSIFICATION only — no policy, provider or coverage detail.
      expect(JSON.stringify(data[0]).toLowerCase()).not.toContain('policy');
    });

    it('bounds the list by clinic, window and page size', async () => {
      await service.appointments(TENANT_ID, query({ days: 7, page: 2, limit: 10 }));

      const [countSql, params] = dataSource.query.mock.calls[0];
      expect(countSql).toContain('a."tenantId" = $1');
      expect(params[0]).toBe(TENANT_ID);
      const [listSql, listParams] = dataSource.query.mock.calls[1];
      expect(listSql).toContain('LIMIT $3 OFFSET $4');
      expect(listParams[2]).toBe(10);
      expect(listParams[3]).toBe(10);
    });
  });

  describe('appointment detail', () => {
    it('names clinic STAFF in full while keeping the patient masked', async () => {
      dataSource.query = jest.fn(async (sql: string) => {
        if (/FROM appointments a\s+LEFT JOIN branches/.test(sql)) return [appointmentRow];
        if (/appointment_status_logs/.test(sql)) {
          return [
            {
              status: 'PENDING_PAYMENT',
              triggered_by: 'ai-bot',
              created_at: new Date('2026-08-01T08:00:00Z'),
            },
          ];
        }
        if (/appointment_services/.test(sql)) return [{ name: 'Dental Cleaning' }];
        if (/staff_profiles sp/.test(sql)) return [{ full_name: 'Dr. Layla Nasser' }];
        return [];
      });

      const result = await service.appointment(TENANT_ID, APPT_ID);

      expect(result.staffName).toBe('Dr. Layla Nasser');
      expect(result.customerName).toBe('M*** A***');
      expect(result.customerEmail).toBe('m***@gmail.com');
      expect(result.serviceNames).toEqual(['Dental Cleaning']);
      expect(result.statusTimeline).toEqual([
        {
          status: 'PENDING_PAYMENT',
          triggeredBy: 'ai-bot',
          at: '2026-08-01T08:00:00.000Z',
        },
      ]);
    });

    it("404s an appointment belonging to a different clinic — the tenant filter is part of the lookup", async () => {
      dataSource.query = jest.fn(async () => []);

      await expect(service.appointment(TENANT_ID, APPT_ID)).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
      const [sql, params] = dataSource.query.mock.calls[0];
      expect(sql).toContain('a."tenantId" = $1');
      expect(params).toEqual([TENANT_ID, APPT_ID]);
    });
  });

  describe('payments', () => {
    const paymentRow = {
      id: 'pay-1',
      appointment_id: APPT_ID,
      status: 'PENDING',
      gateway: 'moyasar',
      amount: '250.00',
      currency: 'SAR',
      payment_method: 'creditcard',
      failure_reason: null,
      refund_status: null,
      created_at: new Date('2026-08-01T08:05:00Z'),
      paid_at: null,
      refunded_at: null,
      link_status: 'ACTIVE',
      link_expires_at: new Date('2026-08-03T08:05:00Z'),
    };

    beforeEach(() => {
      dataSource.query = jest.fn(async (sql: string) =>
        /COUNT\(\*\)::int AS total/.test(sql) ? [{ total: 1 }] : [paymentRow],
      );
    });

    it('returns exactly the allow-listed payment keys — no fees, margins, settlement or metadata', async () => {
      const { data } = await service.payments(TENANT_ID, query());

      expect(Object.keys(data[0]).sort()).toEqual(
        [
          'amount',
          'appointmentId',
          'createdAt',
          'currency',
          'failureReason',
          'gateway',
          'gatewayCallbackReceived',
          'id',
          'paymentLink',
          'paymentMethod',
          'refundStatus',
          'refundedAt',
          'status',
          'succeededAt',
        ].sort(),
      );
    });

    it('never selects the platform economics or the raw gateway payload', async () => {
      await service.payments(TENANT_ID, query());

      const [, ...rest] = dataSource.query.mock.calls;
      const listSql = rest[0][0] as string;
      for (const forbidden of [
        'platform_fee',
        'gateway_fee',
        'net_amount',
        'settlement_status',
        'metadata',
        'gateway_payment_id',
      ]) {
        expect(listSql).not.toContain(forbidden);
      }
    });

    it('answers "did the gateway ever call back?" — a PENDING row with no paid_at means it did not', async () => {
      const { data } = await service.payments(TENANT_ID, query());

      expect(data[0].status).toBe('PENDING');
      expect(data[0].succeededAt).toBeNull();
      expect(data[0].gatewayCallbackReceived).toBe(false);
    });

    it('reports a callback as received once the row has left PENDING', async () => {
      dataSource.query = jest.fn(async (sql: string) =>
        /COUNT\(\*\)::int AS total/.test(sql)
          ? [{ total: 1 }]
          : [{ ...paymentRow, status: 'FAILED', failure_reason: 'card declined by issuer' }],
      );

      const { data } = await service.payments(TENANT_ID, query());

      expect(data[0].gatewayCallbackReceived).toBe(true);
      expect(data[0].failureReason).toBe('card declined by issuer');
    });

    it('sanitizes a gateway failure reason that embeds a URL or long identifier', async () => {
      dataSource.query = jest.fn(async (sql: string) =>
        /COUNT\(\*\)::int AS total/.test(sql)
          ? [{ total: 1 }]
          : [
              {
                ...paymentRow,
                status: 'FAILED',
                failure_reason:
                  'declined; see https://api.moyasar.com/v1/payments/abc?secret=sk_live_1 card 4111111111111111',
              },
            ],
      );

      const { data } = await service.payments(TENANT_ID, query());

      expect(data[0].failureReason).not.toContain('sk_live_1');
      expect(data[0].failureReason).not.toContain('4111111111111111');
      expect(data[0].failureReason).not.toContain('moyasar.com');
    });

    it('reports the live payment-link state so "can the patient still pay?" is answerable', async () => {
      const { data } = await service.payments(TENANT_ID, query());

      expect(data[0].paymentLink).toEqual({
        status: 'ACTIVE',
        expiresAt: '2026-08-03T08:05:00.000Z',
      });
    });

    it('never exposes the payment-link token — the link itself is not Support\'s to hand out', async () => {
      await service.payments(TENANT_ID, query());

      const listSql = dataSource.query.mock.calls[1][0] as string;
      expect(listSql).not.toContain('link_token');
    });

    it('404s an unknown clinic before querying', async () => {
      tenants.exists.mockResolvedValue(false);

      await expect(service.payments(TENANT_ID, query())).rejects.toMatchObject({
        code: ErrorCode.TENANT_NOT_FOUND,
      });
    });
  });

  it('exposes no write path at all — no method can mutate a payment or an appointment', () => {
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(service)).filter(
      (m) => m !== 'constructor',
    );
    for (const method of methods) {
      expect(method).not.toMatch(/refund|capture|void|update|set|mark|cancel|create|delete/i);
    }
  });
});
