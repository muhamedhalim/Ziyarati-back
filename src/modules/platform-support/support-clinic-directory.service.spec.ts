import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { TenantApprovalStatus } from '../../entities/enums';
import { createMockDataSource, MockDataSource } from '../../../test/utils/mock-factories';

import { SupportClinicDirectoryService } from './support-clinic-directory.service';
import { QuerySupportClinicsDto } from './dto/query-support-clinics.dto';

const query = (over: Partial<QuerySupportClinicsDto> = {}) =>
  Object.assign(new QuerySupportClinicsDto(), over);

const row = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Bright Smile Clinic',
  slug: 'bright-smile',
  contact_email: 'clinic@example.com',
  contact_phone: '+966500000000',
  is_active: true,
  approval_status: 'APPROVED',
  created_at: new Date('2026-01-01T00:00:00Z'),
  subscription_status: 'ACTIVE',
  plan_name: 'Growth',
  branches_total: 3,
  branches_active: 2,
  open_tickets: 4,
  total_tickets: 11,
  last_ticket_activity_at: new Date('2026-08-05T09:30:00Z'),
};

describe('SupportClinicDirectoryService', () => {
  let service: SupportClinicDirectoryService;
  let dataSource: MockDataSource;
  /** Every SQL string the service issued, in order. */
  let issued: { sql: string; params: unknown[] }[];

  beforeEach(async () => {
    dataSource = createMockDataSource();
    issued = [];
    dataSource.query = jest.fn(async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      return /COUNT\(\*\)::int AS total FROM tenants/.test(sql) ? [{ total: 1 }] : [row];
    });

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SupportClinicDirectoryService,
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = moduleRef.get(SupportClinicDirectoryService);
  });

  const listSql = () => issued.find((i) => /WITH page AS/.test(i.sql))!;

  describe('the projection', () => {
    it('returns exactly the allow-listed directory keys — nothing else', async () => {
      const { data } = await service.list(query());

      expect(Object.keys(data[0]).sort()).toEqual(
        [
          'approvalStatus',
          'branchesActive',
          'branchesTotal',
          'contactEmail',
          'contactPhone',
          'createdAt',
          'id',
          'isActive',
          'lastTicketActivityAt',
          'name',
          'openTicketCount',
          'planName',
          'slug',
          'subscriptionStatus',
          'totalTicketCount',
        ].sort(),
      );
    });

    /**
     * The Super Admin tenant directory is the thing this endpoint exists to
     * NOT be. If any of these ever appear in the SQL, Support has been handed
     * the administrative view of a tenant by accident.
     */
    it('never selects verification, legal-identity or pricing columns', async () => {
      await service.list(query());

      const sql = issued.map((i) => i.sql).join('\n');
      for (const forbidden of [
        'commercial_registration_number',
        'legal_name',
        'verification',
        'tenant_verification_documents',
        'pl.price',
        'monthly_price',
        'rejection_reason',
      ]) {
        expect(sql).not.toContain(forbidden);
      }
    });

    it('exposes the plan NAME but never joins the plan price', async () => {
      const { data } = await service.list(query());

      expect(data[0].planName).toBe('Growth');
      expect(listSql().sql).toContain('pl.name');
      expect(listSql().sql).not.toMatch(/pl\.(price|cost|amount)/);
    });

    it('serialises timestamps as ISO strings, and a missing one as null', async () => {
      const { data } = await service.list(query());

      expect(data[0].createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(data[0].lastTicketActivityAt).toBe('2026-08-05T09:30:00.000Z');
    });

    it('reports a clinic with no tickets or branches as zero, not null', async () => {
      dataSource.query = jest.fn(async (sql: string) =>
        /COUNT\(\*\)::int AS total FROM tenants/.test(sql)
          ? [{ total: 1 }]
          : [
              {
                ...row,
                branches_total: null,
                branches_active: null,
                open_tickets: null,
                total_tickets: null,
                last_ticket_activity_at: null,
                subscription_status: null,
                plan_name: null,
              },
            ],
      );

      const { data } = await service.list(query());

      expect(data[0].branchesTotal).toBe(0);
      expect(data[0].openTicketCount).toBe(0);
      expect(data[0].totalTicketCount).toBe(0);
      expect(data[0].lastTicketActivityAt).toBeNull();
      expect(data[0].planName).toBeNull();
    });
  });

  describe('search and filters', () => {
    it('matches name, slug, contact email AND contact phone from one term', async () => {
      await service.list(query({ search: '0500000' }));

      const { sql, params } = listSql();
      expect(sql).toContain('t.name ILIKE');
      expect(sql).toContain('t.slug ILIKE');
      expect(sql).toContain('t.contact_email ILIKE');
      expect(sql).toContain('t.contact_phone ILIKE');
      expect(params).toContain('%0500000%');
    });

    it('parameterises the search term rather than interpolating it', async () => {
      await service.list(query({ search: "'; DROP TABLE tenants; --" }));

      const { sql, params } = listSql();
      expect(sql).not.toContain('DROP TABLE');
      expect(params).toContain("%'; DROP TABLE tenants; --%");
    });

    it('trims whitespace and ignores a blank search', async () => {
      await service.list(query({ search: '   ' }));

      expect(listSql().sql).not.toContain('ILIKE');
    });

    it('filters by approval state', async () => {
      await service.list(query({ approvalStatus: TenantApprovalStatus.SUSPENDED }));

      const { sql, params } = listSql();
      expect(sql).toContain('t.approval_status = $');
      expect(params).toContain('SUSPENDED');
    });

    it('converts the isActive string to a real boolean parameter', async () => {
      await service.list(query({ isActive: 'false' }));

      expect(listSql().params).toContain(false);
    });

    it('always excludes soft-deleted clinics', async () => {
      await service.list(query());

      expect(listSql().sql).toContain('t.deleted_at IS NULL');
    });
  });

  describe('pagination and query shape', () => {
    it('paginates, and reports total from a separate count', async () => {
      const result = await service.list(query({ page: 3, limit: 10 }));

      expect(result.page).toBe(3);
      expect(result.limit).toBe(10);
      expect(result.total).toBe(1);
      expect(listSql().params.slice(-2)).toEqual([10, 20]);
    });

    /**
     * The whole point of the CTE: aggregates are evaluated for the PAGE, not
     * for every tenant on the platform. If the LIMIT ever moves out of the
     * `page` CTE, branch/ticket counts start being computed for the entire
     * tenant table on every directory load.
     */
    it('bounds the page BEFORE joining the aggregates', async () => {
      await service.list(query());

      const { sql } = listSql();
      const cteEnd = sql.indexOf(')\n        SELECT p.*');
      const pageCte = sql.slice(0, cteEnd);
      expect(pageCte).toContain('LIMIT $');
      expect(pageCte).not.toContain('support_tickets');
      expect(pageCte).not.toContain('branches');
    });

    it('issues exactly two statements regardless of how many clinics come back', async () => {
      dataSource.query = jest.fn(async (sql: string, params: unknown[] = []) => {
        issued.push({ sql, params });
        return /COUNT\(\*\)::int AS total FROM tenants/.test(sql)
          ? [{ total: 40 }]
          : Array.from({ length: 25 }, (_, i) => ({ ...row, id: `t${i}` }));
      });

      const { data } = await service.list(query());

      expect(data).toHaveLength(25);
      expect(issued).toHaveLength(2);
    });
  });
});
