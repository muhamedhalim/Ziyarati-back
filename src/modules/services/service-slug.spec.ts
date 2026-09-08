import { Test, TestingModule } from '@nestjs/testing';
import { DataSource, QueryFailedError } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import { ServiceService } from './service.service';
import { ServiceCategoryService } from './service-category.service';
import { ServicePublicSlug1730097000000 } from '../../migrations/1730097000000-ServicePublicSlug';
import { Service } from '../../entities/Services/Service';
import { AppointmentService as AppointmentServiceEntity } from '../../entities/Calendar&Appointments/AppointmentService';
import { StaffService as StaffServiceEntity } from '../../entities/Staff/StaffService';
import {
  createMockRepository,
  createMockEntityManager,
  createMockDataSource,
  MockRepository,
  MockDataSource,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('ServiceService.create — public_slug (Marketplace BE-4, T065)', () => {
  let service: ServiceService;
  let services: MockRepository;
  let dataSource: MockDataSource;

  beforeEach(async () => {
    services = createMockRepository();
    const manager = createMockEntityManager();
    dataSource = createMockDataSource(manager);

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ServiceService,
        { provide: getRepositoryToken(Service), useValue: services },
        {
          provide: getRepositoryToken(AppointmentServiceEntity),
          useValue: createMockRepository(),
        },
        {
          provide: getRepositoryToken(StaffServiceEntity),
          useValue: createMockRepository(),
        },
        {
          provide: ServiceCategoryService,
          useValue: { findOneOrThrow: jest.fn() },
        },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = moduleRef.get(ServiceService);

    services.findOne.mockResolvedValueOnce(null); // assertNameUnique: no existing row
  });

  it('assigns a name-derived slug, avoiding candidates the live per-tenant query reports as taken', async () => {
    dataSource.query.mockResolvedValueOnce([
      { public_slug: 'teeth-cleaning' },
      { public_slug: 'teeth-cleaning-2' },
    ]);
    services.save.mockResolvedValueOnce({ id: 'svc-1' });
    services.findOne.mockResolvedValueOnce({ id: 'svc-1' });

    await service.create(TENANT, {
      name: 'Teeth Cleaning',
      durationMinutes: 30,
    } as any);

    expect(services.create).toHaveBeenCalledWith(
      expect.objectContaining({ public_slug: 'teeth-cleaning-3' }),
    );
    expect(dataSource.query).toHaveBeenCalledWith(expect.any(String), [
      TENANT,
      'teeth-cleaning',
      'teeth-cleaning-%',
    ]);
  });

  it('retries with a freshly regenerated slug when the INSERT itself races on public_slug', async () => {
    dataSource.query.mockResolvedValueOnce([]); // pre-check: nothing taken (racing request not visible yet)

    const conflict = Object.assign(
      new QueryFailedError('INSERT', [], new Error('duplicate key')),
      { code: '23505', constraint: 'UQ_services_tenant_public_slug' },
    );
    services.save.mockRejectedValueOnce(conflict); // first attempt loses the race
    dataSource.query.mockResolvedValueOnce([{ public_slug: 'teeth-cleaning' }]); // regenerated pre-check sees the winner now
    services.save.mockResolvedValueOnce({ id: 'svc-1' }); // second attempt succeeds
    services.findOne.mockResolvedValueOnce({ id: 'svc-1' });

    await service.create(TENANT, {
      name: 'Teeth Cleaning',
      durationMinutes: 30,
    } as any);

    expect(services.save).toHaveBeenCalledTimes(2);
    expect(services.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ public_slug: 'teeth-cleaning-2' }),
    );
  });

  it('does NOT retry a name conflict as if it were a slug conflict — surfaces the clear existing-name error immediately', async () => {
    services.findOne.mockReset();
    services.findOne.mockResolvedValueOnce({ id: 'existing' }); // assertNameUnique finds a match

    await expect(
      service.create(TENANT, {
        name: 'Teeth Cleaning',
        durationMinutes: 30,
      } as any),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(services.save).not.toHaveBeenCalled();
  });
});

describe('ServicePublicSlug migration (backfill disambiguates per tenant, not globally)', () => {
  function makeQueryMock(responses: Array<[RegExp, unknown]>) {
    return jest.fn(async (sql: string, _params: unknown[]) => {
      for (const [pattern, result] of responses) {
        if (pattern.test(sql)) return result;
      }
      return [];
    });
  }

  it('lets two different tenants both claim the un-suffixed base slug, but disambiguates two same-tenant collisions', async () => {
    const query = makeQueryMock([
      [/ADD COLUMN/, []],
      [
        /SELECT id, "tenantId", name FROM "services"/,
        [
          { id: 'svc-a', tenantId: 'tenant-1', name: 'Teeth Cleaning' },
          { id: 'svc-b', tenantId: 'tenant-2', name: 'Teeth Cleaning' },
          { id: 'svc-c', tenantId: 'tenant-1', name: 'Teeth Cleaning' },
        ],
      ],
      [
        /SELECT "tenantId", "public_slug" FROM "services" WHERE "public_slug" IS NOT NULL/,
        [],
      ],
      [/SELECT COUNT\(\*\)::int AS c/, [{ c: 0 }]],
    ]);
    await new ServicePublicSlug1730097000000().up({ query } as any);

    const updates = query.mock.calls.filter(([s]) =>
      /UPDATE "services" SET "public_slug"/.test(s as string),
    );
    expect(updates).toHaveLength(3);
    expect(
      updates.some(
        ([, params]) =>
          (params as unknown[])[0] === 'teeth-cleaning' &&
          (params as unknown[])[1] === 'svc-a',
      ),
    ).toBe(true);
    // Different tenant, same name — also claims the un-suffixed base (no cross-tenant collision).
    expect(
      updates.some(
        ([, params]) =>
          (params as unknown[])[0] === 'teeth-cleaning' &&
          (params as unknown[])[1] === 'svc-b',
      ),
    ).toBe(true);
    // Same tenant as svc-a, same name — disambiguated.
    expect(
      updates.some(
        ([, params]) =>
          (params as unknown[])[0] === 'teeth-cleaning-2' &&
          (params as unknown[])[1] === 'svc-c',
      ),
    ).toBe(true);
  });

  it('throws rather than tightening the column when a row is still NULL after the backfill loop', async () => {
    const query = makeQueryMock([
      [/ADD COLUMN/, []],
      [/SELECT id, "tenantId", name FROM "services"/, []],
      [/SELECT COUNT\(\*\)::int AS c/, [{ c: 1 }]],
    ]);
    await expect(
      new ServicePublicSlug1730097000000().up({ query } as any),
    ).rejects.toThrow(/still have a NULL/);
  });
});
